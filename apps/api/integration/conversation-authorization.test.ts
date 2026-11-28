import { describe, it, expect, beforeAll } from 'vitest'
import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

/**
 * PR #2 · Autorización de conversaciones y adjuntos — aceptación con datos
 * SINTÉTICOS contra una base real.
 *
 * Sin mocks: habla con la API que está corriendo (JWT sintético) y con la
 * base por `service_role` solo para leer y comprobar. Cada prueba responde a
 * una pregunta de control:
 *
 *   MENSAJES     · ¿Quién puede escribir en un chat? ¿Qué pasa si el chat
 *                  cambió de titular mientras el agente redactaba?
 *   TRANSFERENCIAS · ¿La transferencia exige permiso, motivo y versión? ¿Queda
 *                  auditada en la MISMA transacción? ¿Dos peticiones con la
 *                  misma versión producen un solo cambio?
 *   ADJUNTOS     · ¿Puede un agente ajeno listar, leer, descargar o borrar los
 *                  adjuntos de un ticket que no es suyo?
 *
 * Una puerta que no puede ejecutarse NO es una puerta verde: si el entorno
 * falta y los controles son obligatorios (`E2E_CONTROLS_REQUIRED=1`, que es lo
 * que hace el CI), la suite FALLA en vez de omitirse.
 */

const API_URL = process.env.E2E_API_URL ?? 'http://localhost:3000'
const SB_URL = process.env.SUPABASE_URL
const PUBLISHABLE = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
const SERVICE = process.env.SUPABASE_SECRET_KEY
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL
const AGENT_EMAIL = process.env.E2E_AGENT_EMAIL
const AGENT2_EMAIL = process.env.E2E_AGENT2_EMAIL
/** Agente sin acceso a nada: sirve para comprobar que los controles niegan. */
const OUTSIDER_EMAIL = 'e2e.outsider@example.test'
const PASSWORD = process.env.E2E_PASSWORD

const enabled = Boolean(
  SB_URL && PUBLISHABLE && SERVICE && ADMIN_EMAIL && AGENT_EMAIL && AGENT2_EMAIL && PASSWORD,
)
const required = process.env.E2E_CONTROLS_REQUIRED === '1'

if (!enabled && required) {
  console.warn(
    '[pr2] Controles obligatorios sin entorno: la suite FALLA en vez de omitirse.',
  )
}

async function signIn(email: string, password: string): Promise<string> {
  const client = createClient(SB_URL!, PUBLISHABLE!, { auth: { persistSession: false } })
  const { data, error } = await client.auth.signInWithPassword({ email, password })
  if (error) throw new Error(`signIn(${email}): ${error.message}`)
  const token = data.session?.access_token
  if (!token) throw new Error(`signIn(${email}): sin token`)
  return token
}

async function api(
  token: string,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${API_URL}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  })
  const text = await res.text()
  let body: any = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text
  }
  return { status: res.status, body }
}

const suite = enabled ? describe : required ? describe : describe.skip

suite('PR2 · autorización de conversaciones y adjuntos', () => {
  let adminToken = ''
  let agentToken = ''
  let agent2Token = ''
  let outsiderToken = ''
  let adminId = ''
  let agentId = ''
  let agent2Id = ''
  let outsiderId = ''
  let service: ReturnType<typeof createClient>

  /** Fixtures: un cliente, un ticket con titular y un chat con titular. */
  let contactId = ''
  let categoryId = ''
  let chatId = '' // titular: agentId
  let queueChatId = '' // sin titular
  let ticketId = '' // titular: agentId
  let messageId = ''
  let mediaPath = ''
  const mediaContent = 'Contenido sintético del adjunto.\nsegunda línea\n'

  beforeAll(async () => {
    if (!enabled) {
      throw new Error(
        'Los controles de autorización son obligatorios y no hay entorno: ' +
          'falta SUPABASE_URL, la clave publicable, service_role o las credenciales sintéticas.',
      )
    }
    service = createClient(SB_URL!, SERVICE!, { auth: { persistSession: false } })

    adminToken = await signIn(ADMIN_EMAIL!, PASSWORD!)
    agentToken = await signIn(AGENT_EMAIL!, PASSWORD!)
    agent2Token = await signIn(AGENT2_EMAIL!, PASSWORD!)

    // El agente ajeno: existe, tiene permisos de soporte y no tiene acceso a
    // ningún ticket ni a ningún chat de esta suite.
    // Idempotente: si una corrida anterior lo dejó, se borra primero.
    const { data: existing } = await service.auth.admin.listUsers({ page: 1, perPage: 200 })
    const previous = existing?.users.find((u) => u.email?.toLowerCase() === OUTSIDER_EMAIL)
    if (previous) await service.auth.admin.deleteUser(previous.id)
    const { data: created, error: oErr } = await service.auth.admin.createUser({
      email: OUTSIDER_EMAIL,
      password: PASSWORD!,
      email_confirm: true,
      user_metadata: { display_name: 'E2E Agente Ajeno' },
    })
    if (oErr) throw new Error(`outsider: ${oErr.message}`)
    outsiderId = created.user.id
    await service
      .from('profiles')
      .update({ role_key: 'soporte', role: 'soporte' })
      .eq('id', outsiderId)
    outsiderToken = await signIn(OUTSIDER_EMAIL, PASSWORD!)

    const me = await api(agentToken, '/api/me')
    agentId = me.body?.data?.id
    const me2 = await api(agent2Token, '/api/me')
    agent2Id = me2.body?.data?.id
    const meAdmin = await api(adminToken, '/api/me')
    adminId = meAdmin.body?.data?.id
    expect(agentId).toBeTruthy()
    expect(agent2Id).toBeTruthy()
    expect(adminId).toBeTruthy()

    // Un cliente sintético propio de esta suite.
    const phone = '+5255500099' + String(Date.now() % 10000).padStart(4, '0')
    const { data: contact, error: cErr } = await service
      .from('contacts')
      .insert({ whatsapp_number: phone, name: 'Cliente de controles', country: 'MX' })
      .select('id')
      .single<{ id: string }>()
    if (cErr) throw new Error(`contacts: ${cErr.message}`)
    contactId = contact.id

    const { data: category } = await service
      .from('categories')
      .select('id')
      .limit(1)
      .maybeSingle<{ id: string }>()
    categoryId = category?.id ?? ''
    if (!categoryId) throw new Error('no hay categoría sintética: corre la semilla')

    // Un chat con titular (el agente A) y otro en la cola.
    const { data: chat, error: chErr } = await service
      .from('conversations')
      .insert({ contact_id: contactId, assigned_agent_id: agentId, status: 'open' })
      .select('id, assignment_version')
      .single<{ id: string; assignment_version: number }>()
    if (chErr) throw new Error(`conversations: ${chErr.message}`)
    chatId = chat.id

    const { data: queueChat, error: qErr } = await service
      .from('conversations')
      .insert({ contact_id: contactId, assigned_agent_id: null, status: 'open' })
      .select('id')
      .single<{ id: string }>()
    if (qErr) throw new Error(`conversations (cola): ${qErr.message}`)
    queueChatId = queueChat.id

    // Un ticket con titular conocido (el agente A).
    const { data: ticket, error: tErr } = await service
      .from('tickets')
      .insert({
        contact_id: contactId,
        category_id: categoryId,
        assigned_to: agentId,
        name: 'Ticket de controles',
        description: { type: 'doc', content: [] },
        description_plain: 'Ticket de controles',
        status: 'open',
        created_by: agentId,
      })
      .select('id')
      .single<{ id: string }>()
    if (tErr) throw new Error(`tickets: ${tErr.message}`)
    ticketId = ticket.id

    // El archivo sintético, con contenido, en el bucket de la app.
    mediaPath = `attachments/${chatId}/evidencia.txt`
    const { error: upErr } = await service.storage
      .from('whatsapp-media')
      .upload(mediaPath, mediaContent, { contentType: 'text/plain', upsert: true })
    if (upErr) throw new Error(`storage: ${upErr.message}`)

    // El mensaje que lleva el archivo, en el chat de A.
    const { data: message, error: mErr } = await service
      .from('messages')
      .insert({
        conversation_id: chatId,
        direction: 'in',
        body: 'Mensaje con evidencia',
        media_urls: [mediaPath],
      })
      .select('id')
      .single<{ id: string }>()
    if (mErr) throw new Error(`messages: ${mErr.message}`)
    messageId = message.id

    const { error: aErr } = await service.from('ticket_message_attachments').insert({
      ticket_id: ticketId,
      message_id: messageId,
      attached_by: agentId,
      note: 'evidencia de control',
    })
    if (aErr) throw new Error(`ticket_message_attachments: ${aErr.message}`)
  })

  async function currentVersion(conversationId: string): Promise<number> {
    const { data, error } = await service
      .from('conversations')
      .select('assignment_version')
      .eq('id', conversationId)
      .single<{ assignment_version: number }>()
    if (error) throw new Error(`assignment_version: ${error.message}`)
    return data.assignment_version
  }

  async function countMessages(body: string): Promise<number> {
    const { count, error } = await service
      .from('messages')
      .select('id', { count: 'exact' })
      .eq('body', body)
    if (error) throw new Error(`count: ${error.message}`)
    return count ?? 0
  }

  // ---------------------------------------------------------------- mensajes

  it('el titular puede responder en su chat y el mensaje queda guardado', async () => {
    const body = `Respuesta del titular ${Date.now()}`
    const res = await api(agentToken, `/api/conversations/${chatId}/messages`, {
      method: 'POST',
      body: { body },
    })
    expect(res.status).toBe(201)
    expect(await countMessages(body)).toBe(1)
  })

  it('un agente ajeno NO puede escribir en el chat de otro', async () => {
    const body = `Intrusión en chat ajeno ${Date.now()}`
    const res = await api(agent2Token, `/api/conversations/${chatId}/messages`, {
      method: 'POST',
      body: { body },
    })
    expect(res.status).toBe(409)
    expect(res.body?.code).toBe('assignment_changed')
    expect(await countMessages(body)).toBe(0)
  })

  it('si el chat cambió de titular mientras redactaba, el mensaje NO se guarda', async () => {
    // Agente A redacta; mientras tanto el admin transfiere el chat a B.
    const draft = `Mensaje de un chat que cambió de manos ${Date.now()}`
    const version = await currentVersion(chatId)
    const transfer = await api(adminToken, `/api/conversations/${chatId}`, {
      method: 'PATCH',
      body: { assigned_agent_id: agent2Id, reason: 'control: cambio de titular', expected_version: version },
    })
    expect(transfer.status).toBe(200)

    // A envía su borrador: ya no es el titular.
    const res = await api(agentToken, `/api/conversations/${chatId}/messages`, {
      method: 'POST',
      body: { body: draft },
    })
    expect(res.status).toBe(409)
    expect(res.body?.code).toBe('assignment_changed')
    // Ni guardado ni encolado: no existe el mensaje.
    expect(await countMessages(draft)).toBe(0)

    // Se devuelve el chat al agente A para el resto de la suite.
    const back = await api(adminToken, `/api/conversations/${chatId}`, {
      method: 'PATCH',
      body: {
        assigned_agent_id: agentId,
        reason: 'control: devolver el chat',
        expected_version: await currentVersion(chatId),
      },
    })
    expect(back.status).toBe(200)
  })

  it('tomar un chat que no existe responde 404, no «ya tomado»', async () => {
    const res = await api(agentToken, '/api/conversations/00000000-0000-0000-0000-000000000000/take', {
      method: 'POST',
    })
    expect(res.status).toBe(404)
    expect(res.body?.code).toBe('conversation_not_found')
  })

  it('un chat sin titular no acepta mensajes', async () => {
    const body = `Mensaje a la cola ${Date.now()}`
    const res = await api(agentToken, `/api/conversations/${queueChatId}/messages`, {
      method: 'POST',
      body: { body },
    })
    expect(res.status).toBe(409)
    expect(res.body?.code).toBe('conversation_unassigned')
    expect(await countMessages(body)).toBe(0)
  })

  // ----------------------------------------------------------- transferencias

  it('la transferencia exige motivo', async () => {
    const res = await api(adminToken, `/api/conversations/${chatId}`, {
      method: 'PATCH',
      body: {
        assigned_agent_id: agent2Id,
        expected_version: await currentVersion(chatId),
      },
    })
    expect(res.status).toBe(400)
  })

  it('la transferencia exige la versión vigente', async () => {
    const res = await api(adminToken, `/api/conversations/${chatId}`, {
      method: 'PATCH',
      body: { assigned_agent_id: agent2Id, reason: 'control: sin versión' },
    })
    expect(res.status).toBe(400)
  })

  it('una versión obsoleta se rechaza y no cambia nada', async () => {
    const before = await currentVersion(chatId)
    const res = await api(adminToken, `/api/conversations/${chatId}`, {
      method: 'PATCH',
      body: {
        assigned_agent_id: agent2Id,
        reason: 'control: versión obsoleta',
        expected_version: before - 1,
      },
    })
    expect(res.status).toBe(409)
    expect(res.body?.code).toBe('version_conflict')
    expect(await currentVersion(chatId)).toBe(before)
  })

  it('A → B cambia el titular y deja la auditoría completa', async () => {
    const version = await currentVersion(chatId)
    const reason = 'control: A → B'
    const res = await api(adminToken, `/api/conversations/${chatId}`, {
      method: 'PATCH',
      body: { assigned_agent_id: agent2Id, reason, expected_version: version },
    })
    expect(res.status).toBe(200)
    expect(res.body?.data?.assigned_agent_id).toBe(agent2Id)

    const { data: rows, error } = await service
      .from('conversation_audit_log')
      .select(
        'actor_id, previous_assignee_id, new_assignee_id, reason, version_before, version_after, created_at',
      )
      .eq('conversation_id', chatId)
      .eq('reason', reason)
      .order('created_at', { ascending: false })
      .limit(1)
    if (error) throw new Error(`conversation_audit_log: ${error.message}`)
    const entry = rows?.[0]
    expect(entry).toBeTruthy()
    expect(entry?.actor_id).toBe(adminId)
    expect(entry?.previous_assignee_id).toBe(agentId)
    expect(entry?.new_assignee_id).toBe(agent2Id)
    expect(entry?.reason).toBe(reason)
    expect(entry?.version_before).toBe(version)
    expect(entry?.version_after).toBe(version + 1)
    expect(entry?.created_at).toBeTruthy()
  })

  it('A → cola deja el chat sin titular y también lo audita', async () => {
    const version = await currentVersion(chatId)
    const reason = 'control: A → cola'
    const res = await api(adminToken, `/api/conversations/${chatId}`, {
      method: 'PATCH',
      body: { assigned_agent_id: null, reason, expected_version: version },
    })
    expect(res.status).toBe(200)
    expect(res.body?.data?.assigned_agent_id).toBeNull()

    const { data: rows, error } = await service
      .from('conversation_audit_log')
      .select('actor_id, previous_assignee_id, new_assignee_id, reason')
      .eq('conversation_id', chatId)
      .eq('reason', reason)
      .limit(1)
    if (error) throw new Error(`conversation_audit_log: ${error.message}`)
    expect(rows?.[0]).toMatchObject({
      actor_id: adminId,
      previous_assignee_id: agent2Id,
      new_assignee_id: null,
    })
  })

  it('tras A → B, B puede responder y A pierde el acceso al chat', async () => {
    const version = await currentVersion(chatId)
    const transfer = await api(adminToken, `/api/conversations/${chatId}`, {
      method: 'PATCH',
      body: {
        assigned_agent_id: agent2Id,
        reason: 'control: tras la transferencia',
        expected_version: version,
      },
    })
    expect(transfer.status).toBe(200)

    // B responde: es el titular.
    const body = `Respuesta del nuevo titular ${Date.now()}`
    const sent = await api(agent2Token, `/api/conversations/${chatId}/messages`, {
      method: 'POST',
      body: { body },
    })
    expect(sent.status).toBe(201)
    expect(await countMessages(body)).toBe(1)

    // A ya no puede ni leer el chat ni escribir en él.
    const read = await api(agentToken, `/api/conversations/${chatId}`)
    expect(read.status).toBe(403)

    const rejected = await api(agentToken, `/api/conversations/${chatId}/messages`, {
      method: 'POST',
      body: { body: `A intenta escribir ${Date.now()}` },
    })
    expect(rejected.status).toBe(409)
  })

  it('dos peticiones con la misma versión → un solo cambio y un solo evento', async () => {
    const version = await currentVersion(chatId)
    const reason = 'control: carrera de transferencias'

    const first = await api(adminToken, `/api/conversations/${chatId}`, {
      method: 'PATCH',
      body: { assigned_agent_id: agentId, reason, expected_version: version },
    })
    expect(first.status).toBe(200)

    const second = await api(adminToken, `/api/conversations/${chatId}`, {
      method: 'PATCH',
      body: { assigned_agent_id: agent2Id, reason, expected_version: version },
    })
    expect(second.status).toBe(409)
    expect(second.body?.code).toBe('version_conflict')

    const { data: rows, error } = await service
      .from('conversation_audit_log')
      .select('id')
      .eq('conversation_id', chatId)
      .eq('reason', reason)
    if (error) throw new Error(`conversation_audit_log: ${error.message}`)
    expect(rows?.length ?? 0).toBe(1)
  })

  // --------------------------------------------------------------- adjuntos

  it('un agente ajeno no puede LISTAR los adjuntos de un ticket que no es suyo', async () => {
    const res = await api(outsiderToken, `/api/tickets/${ticketId}/attachments`)
    expect(res.status).toBe(403)
    expect(res.body?.code).toBe('forbidden')
  })

  it('un agente ajeno no puede LEER un adjunto', async () => {
    const res = await api(outsiderToken, `/api/tickets/${ticketId}/attachments/${messageId}`)
    expect(res.status).toBe(403)
    expect(res.body?.code).toBe('forbidden')
  })

  it('un agente ajeno no puede BORRAR un adjunto', async () => {
    const res = await api(outsiderToken, `/api/tickets/${ticketId}/attachments/${messageId}`, {
      method: 'DELETE',
    })
    expect(res.status).toBe(403)

    // El adjunto sigue ahí: el rechazo no dejó nada a medias.
    const { data: rows } = await service
      .from('ticket_message_attachments')
      .select('message_id')
      .eq('ticket_id', ticketId)
      .eq('message_id', messageId)
    expect(rows?.length ?? 0).toBe(1)
  })

  it('el titular puede listar y leer el adjunto', async () => {
    const list = await api(agentToken, `/api/tickets/${ticketId}/attachments`)
    expect(list.status).toBe(200)
    expect((list.body?.data ?? []).some((a: any) => a.message_id === messageId)).toBe(true)

    const read = await api(agentToken, `/api/tickets/${ticketId}/attachments/${messageId}`)
    expect(read.status).toBe(200)
    expect(read.body?.data?.message_id).toBe(messageId)
  })

  it('el titular puede DESCARGAR el archivo: la URL firmada entrega el contenido exacto', async () => {
    const read = await api(agentToken, `/api/tickets/${ticketId}/attachments/${messageId}`)
    expect(read.status).toBe(200)
    const signedUrl = read.body?.data?.media_url
    expect(typeof signedUrl).toBe('string')

    const res = await fetch(signedUrl)
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toBe(mediaContent)
  })

  it('el bucket es privado: un autenticado sin la API NO puede leer el objeto', async () => {
    const browser = createClient(SB_URL!, PUBLISHABLE!, { auth: { persistSession: false } })
    const { error } = await browser.storage.from('whatsapp-media').download(mediaPath)
    expect(error).not.toBeNull()
  })

  it('el titular puede BORRAR el adjunto: la fila y el objeto desaparecen', async () => {
    const res = await api(agentToken, `/api/tickets/${ticketId}/attachments/${messageId}`, {
      method: 'DELETE',
    })
    expect(res.status).toBe(204)

    const { data: rows } = await service
      .from('ticket_message_attachments')
      .select('message_id')
      .eq('ticket_id', ticketId)
      .eq('message_id', messageId)
    expect(rows?.length ?? 0).toBe(0)

    // El objeto también: si quedaba en el bucket, seguiría descargable.
    const { error: dlErr } = await service.storage.from('whatsapp-media').download(mediaPath)
    expect(dlErr).not.toBeNull()
  })

  it('después de transferir, el nuevo titular puede leer y el ajeno sigue sin acceso', async () => {
    // Se rehace el adjunto (el anterior se borró) para repetir la comprobación
    // sobre un estado nuevo.
    const { error: upErr } = await service.storage
      .from('whatsapp-media')
      .upload(mediaPath, mediaContent, { contentType: 'text/plain', upsert: true })
    expect(upErr).toBeNull()

    const { data: message, error: mErr } = await service
      .from('messages')
      .insert({
        conversation_id: chatId,
        direction: 'in',
        body: 'Mensaje con evidencia (tras transferir)',
        media_urls: [mediaPath],
      })
      .select('id')
      .single<{ id: string }>()
    expect(mErr).toBeNull()

    const { error: aErr } = await service.from('ticket_message_attachments').insert({
      ticket_id: ticketId,
      message_id: message!.id,
      attached_by: agentId,
    })
    expect(aErr).toBeNull()

    // El chat pasa a B.
    const transfer = await api(adminToken, `/api/conversations/${chatId}`, {
      method: 'PATCH',
      body: {
        assigned_agent_id: agent2Id,
        reason: 'control: transferir para repetir los adjuntos',
        expected_version: await currentVersion(chatId),
      },
    })
    expect(transfer.status).toBe(200)

    // B es ahora el titular del chat: puede leer el adjunto.
    const read = await api(agent2Token, `/api/tickets/${ticketId}/attachments/${message!.id}`)
    expect(read.status).toBe(200)

    // El agente ajeno sigue sin acceso, ahora también al chat.
    const outsiderRead = await api(
      outsiderToken,
      `/api/tickets/${ticketId}/attachments/${message!.id}`,
    )
    expect(outsiderRead.status).toBe(403)
    const outsiderChat = await api(outsiderToken, `/api/conversations/${chatId}`)
    expect(outsiderChat.status).toBe(403)

    // A conserva el acceso al TICKET (es su titular) pero pierde el del CHAT:
    // ese es el acceso que corresponde a la conversación.
    const stillTicket = await api(agentToken, `/api/tickets/${ticketId}/attachments/${message!.id}`)
    expect(stillTicket.status).toBe(200)
    const lostChat = await api(agentToken, `/api/conversations/${chatId}`)
    expect(lostChat.status).toBe(403)
  })
})

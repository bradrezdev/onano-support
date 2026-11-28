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
 *   POR CHAT     · La visibilidad es POR ADJUNTO: un ticket con evidencia de
 *                  dos chats muestra al titular las dos, y a quien solo
 *                  atiende un chat, sólo la de ese chat (listado, vista previa
 *                  y descarga).
 *   CONSERVACIÓN · Desvincular nunca borra el archivo; el borrado físico es una
 *                  operación autorizada que comprueba referencias y ventana de
 *                  conservación, y deja bitácora.
 *   RE-AUTORIZACIÓN · El agente que pierde el chat o el permiso ya no puede
 *                  descargar: la API lo comprueba en cada petición.
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
/**
 * Agente con un rol PROPIO y temporal: primero puede leer sus adjuntos y
 * después se le quita el permiso (o el chat). Es el control de "la siguiente
 * descarga vuelve a comprobar la autorización".
 */
const TEMP_EMAIL = 'e2e.temp@example.test'
const TEMP_ROLE_KEY = 'e2e_temporal'
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

/**
 * La respuesta CRUDA: la descarga de un adjunto devuelve BYTES, no JSON.
 * Con `api` el cuerpo binario no se puede ni leer ni comparar.
 */
async function apiRaw(
  token: string,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<Response> {
  return fetch(`${API_URL}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  })
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

  // Fixtures de los controles de adjuntos por chat y de la purga.
  let chatTwoA = '' // titular: agentId
  let chatTwoB = '' // titular: agent2Id
  let ticketTwo = '' // titular: agentId, evidencia de DOS chats
  let ticketOther = '' // titular: agentId, el MISMO mensaje que ticketTwo
  let messageTwoA = ''
  let messageTwoB = ''
  let pathTwoA = ''
  let pathTwoB = ''
  let messagePurge = ''
  let pathPurge = ''
  const mediaTwoContent = 'Contenido sintético del adjunto (dos chats).\n'

  // Fixtures del agente que pierde el acceso.
  let tempAgentId = ''
  let tempToken = ''
  let tempRoleId = ''
  let chatTemp1 = ''
  let chatTemp2 = ''
  let ticketTemp = ''
  let messageTemp1 = ''
  let messageTemp2 = ''
  let pathTemp1 = ''
  let pathTemp2 = ''

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

    // -----------------------------------------------------------------
    // Evidencia aislada POR CHAT: un ticket con mensajes de dos chats.
    // -----------------------------------------------------------------
    const { data: chatA, error: cAErr } = await service
      .from('conversations')
      .insert({ contact_id: contactId, assigned_agent_id: agentId, status: 'open' })
      .select('id')
      .single<{ id: string }>()
    if (cAErr) throw new Error(`conversations (A): ${cAErr.message}`)
    chatTwoA = chatA.id

    const { data: chatB, error: cBErr } = await service
      .from('conversations')
      .insert({ contact_id: contactId, assigned_agent_id: agent2Id, status: 'open' })
      .select('id')
      .single<{ id: string }>()
    if (cBErr) throw new Error(`conversations (B): ${cBErr.message}`)
    chatTwoB = chatB.id

    const { data: tTwo, error: tTwoErr } = await service
      .from('tickets')
      .insert({
        contact_id: contactId,
        category_id: categoryId,
        assigned_to: agentId,
        name: 'e2e.Ticket de evidencia (dos chats)',
        description: { type: 'doc', content: [] },
        description_plain: 'Ticket de evidencia (dos chats)',
        status: 'open',
        created_by: agentId,
      })
      .select('id')
      .single<{ id: string }>()
    if (tTwoErr) throw new Error(`tickets (dos chats): ${tTwoErr.message}`)
    ticketTwo = tTwo.id

    const { data: tOther, error: tOtherErr } = await service
      .from('tickets')
      .insert({
        contact_id: contactId,
        category_id: categoryId,
        assigned_to: agentId,
        name: 'e2e.Ticket de evidencia (mismo archivo)',
        description: { type: 'doc', content: [] },
        description_plain: 'Ticket de evidencia (mismo archivo)',
        status: 'open',
        created_by: agentId,
      })
      .select('id')
      .single<{ id: string }>()
    if (tOtherErr) throw new Error(`tickets (mismo archivo): ${tOtherErr.message}`)
    ticketOther = tOther.id

    pathTwoA = `attachments/${chatTwoA}/evidencia-a.txt`
    pathTwoB = `attachments/${chatTwoB}/evidencia-b.txt`
    await uploadFixture(pathTwoA, mediaTwoContent)
    await uploadFixture(pathTwoB, mediaTwoContent)

    const { data: mA, error: mAErr } = await service
      .from('messages')
      .insert({
        conversation_id: chatTwoA,
        direction: 'in',
        body: 'Evidencia del chat A',
        media_urls: [pathTwoA],
      })
      .select('id')
      .single<{ id: string }>()
    if (mAErr) throw new Error(`messages (A): ${mAErr.message}`)
    messageTwoA = mA.id

    const { data: mB, error: mBErr } = await service
      .from('messages')
      .insert({
        conversation_id: chatTwoB,
        direction: 'in',
        body: 'Evidencia del chat B',
        media_urls: [pathTwoB],
      })
      .select('id')
      .single<{ id: string }>()
    if (mBErr) throw new Error(`messages (B): ${mBErr.message}`)
    messageTwoB = mB.id

    // El MISMO mensaje queda en DOS tickets: el mismo archivo, dos
    // referencias. Desvincularlo del primero no puede romper el segundo.
    for (const t of [ticketTwo, ticketOther]) {
      const { error } = await service.from('ticket_message_attachments').insert({
        ticket_id: t,
        message_id: messageTwoA,
        attached_by: agentId,
      })
      if (error) throw new Error(`ticket_message_attachments (${t}): ${error.message}`)
    }
    const { error: linkBErr } = await service
      .from('ticket_message_attachments')
      .insert({ ticket_id: ticketTwo, message_id: messageTwoB, attached_by: agentId })
    if (linkBErr) throw new Error(`ticket_message_attachments (B): ${linkBErr.message}`)

    // El mensaje cuyo archivo se va a purgar.
    pathPurge = `attachments/${chatTwoB}/evidencia-purga.txt`
    await uploadFixture(pathPurge, mediaTwoContent)
    const { data: mP, error: mPErr } = await service
      .from('messages')
      .insert({
        conversation_id: chatTwoB,
        direction: 'in',
        body: 'Evidencia para purgar',
        media_urls: [pathPurge],
      })
      .select('id')
      .single<{ id: string }>()
    if (mPErr) throw new Error(`messages (purga): ${mPErr.message}`)
    messagePurge = mP.id
    const { error: linkPErr } = await service
      .from('ticket_message_attachments')
      .insert({ ticket_id: ticketTwo, message_id: messagePurge, attached_by: agentId })
    if (linkPErr) throw new Error(`ticket_message_attachments (purga): ${linkPErr.message}`)

    // -----------------------------------------------------------------
    // El agente que pierde el acceso: rol propio, chats propios.
    // -----------------------------------------------------------------
    const { data: existingUsers } = await service.auth.admin.listUsers({ page: 1, perPage: 200 })
    const previousTemp = existingUsers?.users.find(
      (u) => u.email?.toLowerCase() === TEMP_EMAIL,
    )
    if (previousTemp) await service.auth.admin.deleteUser(previousTemp.id)
    const { data: existingTempRole } = await service
      .from('roles')
      .select('id')
      .eq('key', TEMP_ROLE_KEY)
      .maybeSingle<{ id: string }>()
    if (existingTempRole) await service.from('roles').delete().eq('id', existingTempRole.id)

    const { data: createdTemp, error: tempErr } = await service.auth.admin.createUser({
      email: TEMP_EMAIL,
      password: PASSWORD!,
      email_confirm: true,
      user_metadata: { display_name: 'E2E Agente Temporal' },
    })
    if (tempErr) throw new Error(`agente temporal: ${tempErr.message}`)
    tempAgentId = createdTemp.user.id

    const { data: tempRole, error: tempRoleErr } = await service
      .from('roles')
      .insert({
        key: TEMP_ROLE_KEY,
        name: 'e2e.Autor temporal',
        description: 'Rol sintético para el control de pérdida de permiso',
        color: '#64748b',
        is_system: false,
        created_by: adminId,
      })
      .select('id')
      .single<{ id: string }>()
    if (tempRoleErr) throw new Error(`roles: ${tempRoleErr.message}`)
    tempRoleId = tempRole.id
    const { error: tempPermErr } = await service.from('role_permissions').insert([
      { role_id: tempRoleId, permission_key: 'ticket.read', granted_by: adminId },
      { role_id: tempRoleId, permission_key: 'ticket.reply', granted_by: adminId },
    ])
    if (tempPermErr) throw new Error(`role_permissions: ${tempPermErr.message}`)

    await service
      .from('profiles')
      .update({ role_key: TEMP_ROLE_KEY, role: 'soporte' })
      .eq('id', tempAgentId)
    tempToken = await signIn(TEMP_EMAIL, PASSWORD!)

    const { data: cT1, error: cT1Err } = await service
      .from('conversations')
      .insert({ contact_id: contactId, assigned_agent_id: tempAgentId, status: 'open' })
      .select('id')
      .single<{ id: string }>()
    if (cT1Err) throw new Error(`conversations (temporal 1): ${cT1Err.message}`)
    chatTemp1 = cT1.id

    const { data: cT2, error: cT2Err } = await service
      .from('conversations')
      .insert({ contact_id: contactId, assigned_agent_id: tempAgentId, status: 'open' })
      .select('id')
      .single<{ id: string }>()
    if (cT2Err) throw new Error(`conversations (temporal 2): ${cT2Err.message}`)
    chatTemp2 = cT2.id

    // El ticket lo tiene otro (el agente A): la evidencia del agente temporal
    // le llega por SU chat, no por el ticket.
    const { data: tT, error: tTErr } = await service
      .from('tickets')
      .insert({
        contact_id: contactId,
        category_id: categoryId,
        assigned_to: agentId,
        name: 'e2e.Ticket del agente temporal',
        description: { type: 'doc', content: [] },
        description_plain: 'Ticket del agente temporal',
        status: 'open',
        created_by: agentId,
      })
      .select('id')
      .single<{ id: string }>()
    if (tTErr) throw new Error(`tickets (temporal): ${tTErr.message}`)
    ticketTemp = tT.id

    pathTemp1 = `attachments/${chatTemp1}/temporal-1.txt`
    pathTemp2 = `attachments/${chatTemp2}/temporal-2.txt`
    await uploadFixture(pathTemp1, mediaTwoContent)
    await uploadFixture(pathTemp2, mediaTwoContent)

    const { data: mT1, error: mT1Err } = await service
      .from('messages')
      .insert({
        conversation_id: chatTemp1,
        direction: 'in',
        body: 'Evidencia temporal 1',
        media_urls: [pathTemp1],
      })
      .select('id')
      .single<{ id: string }>()
    if (mT1Err) throw new Error(`messages (temporal 1): ${mT1Err.message}`)
    messageTemp1 = mT1.id

    const { data: mT2, error: mT2Err } = await service
      .from('messages')
      .insert({
        conversation_id: chatTemp2,
        direction: 'in',
        body: 'Evidencia temporal 2',
        media_urls: [pathTemp2],
      })
      .select('id')
      .single<{ id: string }>()
    if (mT2Err) throw new Error(`messages (temporal 2): ${mT2Err.message}`)
    messageTemp2 = mT2.id

    for (const message of [messageTemp1, messageTemp2]) {
      const { error } = await service.from('ticket_message_attachments').insert({
        ticket_id: ticketTemp,
        message_id: message,
        attached_by: agentId,
      })
      if (error) throw new Error(`ticket_message_attachments (temporal): ${error.message}`)
    }
  })

  /** Sube un archivo sintético al bucket de la app. */
  async function uploadFixture(path: string, content: string): Promise<void> {
    const { error } = await service.storage
      .from('whatsapp-media')
      .upload(path, content, { contentType: 'text/plain', upsert: true })
    if (error) throw new Error(`storage (${path}): ${error.message}`)
  }

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

    // La lectura entrega los BYTES del archivo, no un JSON con una URL firmada.
    const read = await apiRaw(agentToken, `/api/tickets/${ticketId}/attachments/${messageId}`)
    expect(read.status).toBe(200)
    expect(read.headers.get('content-type')).toContain('text/plain')
    expect(await read.text()).toBe(mediaContent)
  })

  it('el titular puede DESCARGAR el archivo: la API entrega los bytes exactos', async () => {
    const read = await apiRaw(
      agentToken,
      `/api/tickets/${ticketId}/attachments/${messageId}?download=1`,
    )
    expect(read.status).toBe(200)
    expect(read.headers.get('content-disposition')).toContain('attachment')
    expect(read.headers.get('content-disposition')).toContain('evidencia.txt')
    expect(await read.text()).toBe(mediaContent)
  })

  it('el bucket es privado: un autenticado sin la API NO puede leer el objeto', async () => {
    const browser = createClient(SB_URL!, PUBLISHABLE!, { auth: { persistSession: false } })
    const { error } = await browser.storage.from('whatsapp-media').download(mediaPath)
    expect(error).not.toBeNull()
  })

  it('el titular puede DESVINCULAR el adjunto: la fila desaparece, el objeto NO', async () => {
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

    // El objeto sigue ahí: desvincular NO borra el archivo. El borrado físico
    // es otra operación, autorizada y con sus propias condiciones.
    const { error: dlErr } = await service.storage.from('whatsapp-media').download(mediaPath)
    expect(dlErr).toBeNull()
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
    const read = await apiRaw(agent2Token, `/api/tickets/${ticketId}/attachments/${message!.id}`)
    expect(read.status).toBe(200)

    // El agente ajeno sigue sin acceso, ahora también al chat.
    const outsiderRead = await apiRaw(
      outsiderToken,
      `/api/tickets/${ticketId}/attachments/${message!.id}`,
    )
    expect(outsiderRead.status).toBe(403)
    const outsiderChat = await api(outsiderToken, `/api/conversations/${chatId}`)
    expect(outsiderChat.status).toBe(403)

    // A conserva el acceso al TICKET (es su titular) pero pierde el del CHAT:
    // ese es el acceso que corresponde a la conversación.
    const stillTicket = await apiRaw(
      agentToken,
      `/api/tickets/${ticketId}/attachments/${message!.id}`,
    )
    expect(stillTicket.status).toBe(200)
    const lostChat = await api(agentToken, `/api/conversations/${chatId}`)
    expect(lostChat.status).toBe(403)
  })

  // ------------------------------------------- evidencia aislada POR CHAT

  it('un ticket con evidencia de DOS chats: el titular ve las dos', async () => {
    const list = await api(agentToken, `/api/tickets/${ticketTwo}/attachments`)
    expect(list.status).toBe(200)
    const ids = (list.body?.data ?? []).map((a: any) => a.message_id)
    expect(ids).toContain(messageTwoA)
    expect(ids).toContain(messageTwoB)
  })

  it('quien solo atiende UN chat ve únicamente la evidencia de ese chat', async () => {
    const list = await api(agent2Token, `/api/tickets/${ticketTwo}/attachments`)
    expect(list.status).toBe(200)
    const ids = (list.body?.data ?? []).map((a: any) => a.message_id)
    expect(ids).toContain(messageTwoB)
    expect(ids).not.toContain(messageTwoA)
  })

  it('la vista previa y la descarga del chat ajeno se niegan (403)', async () => {
    const preview = await apiRaw(
      agent2Token,
      `/api/tickets/${ticketTwo}/attachments/${messageTwoA}`,
    )
    expect(preview.status).toBe(403)
    const previewBody = await preview.json()
    expect(previewBody?.code).toBe('forbidden')

    const download = await apiRaw(
      agent2Token,
      `/api/tickets/${ticketTwo}/attachments/${messageTwoA}?download=1`,
    )
    expect(download.status).toBe(403)
  })

  it('la vista previa y la descarga del chat propio entregan los bytes', async () => {
    const preview = await apiRaw(
      agent2Token,
      `/api/tickets/${ticketTwo}/attachments/${messageTwoB}`,
    )
    expect(preview.status).toBe(200)
    expect(preview.headers.get('content-type')).toContain('text/plain')
    expect(preview.headers.get('content-disposition')).toContain('inline')
    expect(await preview.text()).toBe(mediaTwoContent)

    const download = await apiRaw(
      agent2Token,
      `/api/tickets/${ticketTwo}/attachments/${messageTwoB}?download=1`,
    )
    expect(download.status).toBe(200)
    expect(download.headers.get('content-disposition')).toContain('attachment')
    expect(await download.text()).toBe(mediaTwoContent)
  })

  // ------------------------------- el mismo archivo en DOS tickets

  it('el mismo archivo en DOS tickets: al desvincularlo del primero, el segundo sigue abriéndolo', async () => {
    const detach = await api(agentToken, `/api/tickets/${ticketTwo}/attachments/${messageTwoA}`, {
      method: 'DELETE',
    })
    expect(detach.status).toBe(204)

    // El objeto NO se borra al desvincular.
    const { error: dlErr } = await service.storage.from('whatsapp-media').download(pathTwoA)
    expect(dlErr).toBeNull()

    // El segundo ticket sigue abriendo el archivo.
    const still = await apiRaw(
      agentToken,
      `/api/tickets/${ticketOther}/attachments/${messageTwoA}`,
    )
    expect(still.status).toBe(200)
    expect(await still.text()).toBe(mediaTwoContent)

    // Y el mensaje original conserva la ruta.
    const { data: msg } = await service
      .from('messages')
      .select('media_urls')
      .eq('id', messageTwoA)
      .single<{ media_urls: unknown }>()
    expect((msg?.media_urls as string[]) ?? []).toContain(pathTwoA)
  })

  it('la purga se niega mientras quede una referencia viva', async () => {
    const res = await api(
      adminToken,
      `/api/tickets/${ticketTwo}/attachments/${messageTwoA}/purge`,
      { method: 'POST', body: { reason: 'control: purga con referencia viva' } },
    )
    expect(res.status).toBe(409)
    expect(res.body?.code).toBe('attachment_referenced')
  })

  // ------------------------------------------------------ la purga física

  it('la purga exige admin o supervisor', async () => {
    const res = await api(
      agentToken,
      `/api/tickets/${ticketTwo}/attachments/${messagePurge}/purge`,
      { method: 'POST', body: { reason: 'control: purga sin privilegio' } },
    )
    expect(res.status).toBe(403)
    expect(res.body?.code).toBe('forbidden')
  })

  it('la purga se niega mientras la ventana de conservación no ha pasado', async () => {
    const res = await api(
      adminToken,
      `/api/tickets/${ticketTwo}/attachments/${messagePurge}/purge`,
      { method: 'POST', body: { reason: 'control: ventana de conservación' } },
    )
    expect(res.status).toBe(409)
    expect(res.body?.code).toBe('attachment_retention_window')
  })

  it('la purga borra el objeto y deja bitácora cuando la ventana ya pasó', async () => {
    // El mensaje que guarda la ruta es más viejo que la ventana (30 días).
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString()
    const { error: backErr } = await service
      .from('messages')
      .update({ created_at: old })
      .eq('id', messagePurge)
    expect(backErr).toBeNull()

    const res = await api(
      adminToken,
      `/api/tickets/${ticketTwo}/attachments/${messagePurge}/purge`,
      { method: 'POST', body: { reason: 'control: purga autorizada' } },
    )
    expect(res.status).toBe(200)
    expect(res.body?.data?.purged).toBe(true)

    // El objeto ya no está.
    const { error: dlErr } = await service.storage.from('whatsapp-media').download(pathPurge)
    expect(dlErr).not.toBeNull()

    // La bitácora dice quién, qué ticket, qué mensaje, qué ruta, cuándo y por qué.
    const { data: rows, error: logErr } = await service
      .from('attachment_purge_log')
      .select('actor_id, ticket_id, message_id, media_path, reason, created_at')
      .eq('message_id', messagePurge)
      .order('created_at', { ascending: false })
      .limit(1)
    if (logErr) throw new Error(`attachment_purge_log: ${logErr.message}`)
    expect(rows?.[0]).toMatchObject({
      actor_id: adminId,
      ticket_id: ticketTwo,
      message_id: messagePurge,
      media_path: pathPurge,
      reason: 'control: purga autorizada',
    })
    expect(rows?.[0]?.created_at).toBeTruthy()

    // El vínculo desapareció con la purga.
    const { data: links } = await service
      .from('ticket_message_attachments')
      .select('message_id')
      .eq('ticket_id', ticketTwo)
      .eq('message_id', messagePurge)
    expect(links?.length ?? 0).toBe(0)

    // Y la bitácora es append-only: no se puede reescribir.
    const { error: updErr } = await service
      .from('attachment_purge_log')
      .update({ reason: 'reescrito' })
      .eq('message_id', messagePurge)
    expect(updErr).not.toBeNull()
  })

  // --------------------------------- el agente que pierde el acceso

  it('un agente con permiso y titular de su chat descarga el archivo', async () => {
    const res = await apiRaw(tempToken, `/api/tickets/${ticketTemp}/attachments/${messageTemp1}`)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe(mediaTwoContent)
  })

  it('al perder el CHAT, la siguiente descarga se vuelve a comprobar y se niega', async () => {
    // El chat pasa a B: el agente temporal conserva `ticket.read`, pero ya no
    // es el titular del chat del que viene la evidencia.
    const transfer = await api(adminToken, `/api/conversations/${chatTemp1}`, {
      method: 'PATCH',
      body: {
        assigned_agent_id: agent2Id,
        reason: 'control: el chat cambió de manos',
        expected_version: await currentVersion(chatTemp1),
      },
    })
    expect(transfer.status).toBe(200)

    const res = await apiRaw(tempToken, `/api/tickets/${ticketTemp}/attachments/${messageTemp1}`)
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body?.code).toBe('forbidden')
  })

  it('al perder TODOS los permisos, la siguiente descarga se niega', async () => {
    // Todavía es titular de su segundo chat: lo que se le quita es el permiso.
    const before = await apiRaw(tempToken, `/api/tickets/${ticketTemp}/attachments/${messageTemp2}`)
    expect(before.status).toBe(200)

    await service.from('role_permissions').delete().eq('role_id', tempRoleId)

    const res = await apiRaw(tempToken, `/api/tickets/${ticketTemp}/attachments/${messageTemp2}`)
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body?.code).toBe('forbidden')
  })
})

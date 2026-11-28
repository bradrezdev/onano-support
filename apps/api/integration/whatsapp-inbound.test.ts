import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'
import twilio from 'twilio'
import { Client as PgClient } from 'pg'

/**
 * E3 · Recepción de WhatsApp — aceptación con datos SINTÉTICOS contra una
 * base real y la API viva.
 *
 * Sin mocks: las peticiones se firman con el MISMO SDK que usa la ruta
 * (`twilio.validateRequest`), sobre la MISMA URL pública que la ruta
 * reconstruye (`WEBHOOK_BASE_URL` + ruta). Si la ruta validara contra
 * `request.url`, estas pruebas caerían en 403 y no probarían nada.
 *
 * Cada prueba responde a una pregunta de control:
 *
 *   A · ¿Dos entregas SIMULTÁNEAS del mismo mensaje dejan un mensaje, un
 *       hilo y un incremento de no leídos?
 *   B · ¿El primer mensaje de un cliente nuevo crea el cliente y deja el chat
 *       visible en la cola (sin titular), con los dos mensajes y no leídos=2?
 *   C · ¿Un hilo cerrado se REABRE y se REUTILIZA (mismo conversation_id), sin
 *       crear un segundo hilo?
 *   D · ¿Una caída de base responde 5xx sin guardar nada, y el reintento
 *       guarda exactamente un mensaje y un incremento?
 *   E · ¿Una firma inválida se rechaza con 403 sin escribir nada?
 *   F · ¿Un MessageSid repetido no duplica el mensaje ni el contador?
 *   G · ¿El acuse a Twilio es TwiML vacío?
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
const PASSWORD = process.env.E2E_PASSWORD
/** La credencial que el webhook y la prueba comparten. */
const AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN
/** El origen PÚBLICO del webhook: es lo que firmó Twilio. */
const WEBHOOK_BASE_URL = process.env.WEBHOOK_BASE_URL
/** Superusuario: solo para inyectar la caída de base del control D. */
const DATABASE_URL = process.env.DATABASE_URL

const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>'

const enabled = Boolean(
  SB_URL &&
    PUBLISHABLE &&
    SERVICE &&
    ADMIN_EMAIL &&
    AGENT_EMAIL &&
    PASSWORD &&
    AUTH_TOKEN &&
    WEBHOOK_BASE_URL &&
    DATABASE_URL,
)
const required = process.env.E2E_CONTROLS_REQUIRED === '1'

if (!enabled && required) {
  console.warn(
    '[e3] Controles obligatorios sin entorno: la suite FALLA en vez de omitirse.',
  )
}

/** La URL pública que la ruta reconstruye: origen + ruta (sin fragmento). */
const WEBHOOK_URL = enabled
  ? `${new URL(WEBHOOK_BASE_URL!).origin}/api/webhooks/twilio`
  : 'http://localhost:3000/api/webhooks/twilio'

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
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${API_URL}${path}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
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

/** Teléfono sintético y único por corrida (E.164). */
function uniquePhone(): string {
  return `+52155${String(Date.now()).slice(-8)}${Math.floor(Math.random() * 10)}`
}

function uniqueSid(): string {
  return `SMe3${String(Date.now())}${Math.floor(Math.random() * 1000)}`
}

function baseParams(phone: string, sid: string, body: string): Record<string, string> {
  return {
    From: `whatsapp:${phone}`,
    To: 'whatsapp:+14155550001',
    Body: body,
    MessageSid: sid,
    NumMedia: '0',
  }
}

/** Firma la carga EXACTAMENTE como lo hizo Twilio. */
function sign(params: Record<string, string>): string {
  return twilio.getExpectedTwilioSignature(AUTH_TOKEN!, WEBHOOK_URL, params)
}

async function postWebhook(
  params: Record<string, string>,
  signature?: string,
): Promise<{ status: number; contentType: string | null; body: string }> {
  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
  }
  if (signature !== undefined) headers['x-twilio-signature'] = signature
  const res = await fetch(`${API_URL}/api/webhooks/twilio`, {
    method: 'POST',
    headers,
    body: new URLSearchParams(params).toString(),
  })
  return {
    status: res.status,
    contentType: res.headers.get('content-type'),
    body: await res.text(),
  }
}

const suite = enabled ? describe : required ? describe : describe.skip

suite('E3 · recepción de WhatsApp', () => {
  let adminToken = ''
  let agentToken = ''
  let service: ReturnType<typeof createClient>

  /** Números creados por esta corrida: se limpian al terminar. */
  const phones: string[] = []

  beforeAll(async () => {
    if (!enabled) {
      throw new Error(
        'Los controles de recepción son obligatorios y no hay entorno: falta ' +
          'SUPABASE_URL, la clave publicable, service_role, DATABASE_URL, ' +
          'TWILIO_AUTH_TOKEN, WEBHOOK_BASE_URL o las credenciales sintéticas.',
      )
    }
    service = createClient(SB_URL!, SERVICE!, { auth: { persistSession: false } })
    adminToken = await signIn(ADMIN_EMAIL!, PASSWORD!)
    agentToken = await signIn(AGENT_EMAIL!, PASSWORD!)
  })

  afterAll(async () => {
    if (!enabled || !service) return
    // Los clientes creados por la suite se borran (la cascada se lleva sus
    // hilos y sus mensajes): la base sintética no acumula basura.
    for (const phone of phones) {
      await service.from('contacts').delete().eq('whatsapp_number', phone)
    }
  })

  async function contactByPhone(phone: string) {
    const { data, error } = await service
      .from('contacts')
      .select('id, name, whatsapp_number')
      .eq('whatsapp_number', phone)
      .maybeSingle<{ id: string; name: string | null; whatsapp_number: string }>()
    if (error) throw new Error(`contacts: ${error.message}`)
    return data
  }

  async function conversationsOf(contactId: string) {
    const { data, error } = await service
      .from('conversations')
      .select('id, contact_id, assigned_agent_id, status, unread_count, channel')
      .eq('contact_id', contactId)
    if (error) throw new Error(`conversations: ${error.message}`)
    return (
      (data ?? []) as {
        id: string
        contact_id: string
        assigned_agent_id: string | null
        status: string
        unread_count: number
        channel: string
      }[]
    )
  }

  async function messagesBySid(sid: string) {
    const { data, error } = await service
      .from('messages')
      .select('id, conversation_id, direction, body, twilio_sid')
      .eq('twilio_sid', sid)
    if (error) throw new Error(`messages: ${error.message}`)
    return (data ?? []) as { id: string; conversation_id: string; direction: string }[]
  }

  async function countMessagesOf(contactId: string): Promise<number> {
    const { count, error } = await service
      .from('messages')
      .select('id', { count: 'exact' })
      .eq('conversation_id', contactId)
    if (error) throw new Error(`count: ${error.message}`)
    return count ?? 0
  }

  // ------------------------------------------------------------------ A

  it('A · dos entregas simultáneas del mismo mensaje dejan un mensaje, un hilo y un incremento', async () => {
    const phone = uniquePhone()
    phones.push(phone)
    const sid = uniqueSid()
    const params = baseParams(phone, sid, 'mensaje simultáneo')
    const signature = sign(params)

    const [first, second] = await Promise.all([
      postWebhook(params, signature),
      postWebhook(params, signature),
    ])

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)

    // Un mensaje.
    expect((await messagesBySid(sid)).length).toBe(1)

    // Un hilo.
    const contact = await contactByPhone(phone)
    expect(contact).toBeTruthy()
    const conversations = await conversationsOf(contact!.id)
    expect(conversations.length).toBe(1)

    // Un incremento de no leídos.
    expect(conversations[0]!.unread_count).toBe(1)
  })

  // ------------------------------------------------------------------ B

  it('B · el primer mensaje de un cliente nuevo crea el cliente y deja el chat en la cola', async () => {
    const phone = uniquePhone()
    phones.push(phone)
    const sid1 = uniqueSid()
    const sid2 = uniqueSid()

    const first = baseParams(phone, sid1, 'primer mensaje')
    first.ProfileName = 'Cliente Nuevo'
    const second = baseParams(phone, sid2, 'segundo mensaje')

    const r1 = await postWebhook(first, sign(first))
    const r2 = await postWebhook(second, sign(second))
    expect(r1.status).toBe(200)
    expect(r2.status).toBe(200)

    // El cliente se creó (antes se descartaba) y con el nombre de perfil.
    const contact = await contactByPhone(phone)
    expect(contact).toBeTruthy()
    expect(contact!.name).toBe('Cliente Nuevo')

    // Un solo hilo, en la cola: sin titular, abierto y del canal whatsapp.
    const conversations = await conversationsOf(contact!.id)
    expect(conversations.length).toBe(1)
    expect(conversations[0]!.assigned_agent_id).toBeNull()
    expect(conversations[0]!.status).toBe('open')
    expect(conversations[0]!.channel).toBe('whatsapp')

    // Los dos mensajes.
    expect((await messagesBySid(sid1)).length).toBe(1)
    expect((await messagesBySid(sid2)).length).toBe(1)
    expect(await countMessagesOf(conversations[0]!.id)).toBe(2)

    // Y los no leídos son dos.
    expect(conversations[0]!.unread_count).toBe(2)

    // El chat se ve en la COLA del agente (sin titular): la cola es el
    // conjunto de chats sin titular, y el listado de un agente de soporte
    // tiene que devolverlo (y no un 500).
    expect(conversations[0]!.assigned_agent_id).toBeNull()
    const queue = await api(agentToken, '/api/conversations')
    expect(queue.status).toBe(200)
    const ids = (queue.body?.data ?? []).map((c: any) => c.id)
    expect(ids).toContain(conversations[0]!.id)

    // Y también aparece en el listado de la administración.
    const list = await api(adminToken, '/api/conversations')
    expect(list.status).toBe(200)
    expect((list.body?.data ?? []).map((c: any) => c.id)).toContain(conversations[0]!.id)

    // El agente lo puede abrir: un chat sin titular es legible por el equipo
    // (es lo que se ofrece para tomar).
    const detail = await api(agentToken, `/api/conversations/${conversations[0]!.id}`)
    expect(detail.status).toBe(200)
  })

  // ------------------------------------------------------------------ C

  it('C · un hilo cerrado se reabre y se reutiliza: no hay un segundo hilo', async () => {
    const phone = uniquePhone()
    phones.push(phone)
    const sid = uniqueSid()

    // Un cliente con un hilo cerrado (lo que deja el equipo al resolver).
    const { data: contact, error: cErr } = await service
      .from('contacts')
      .insert({ whatsapp_number: phone, name: 'Cliente con hilo cerrado' })
      .select('id')
      .single<{ id: string }>()
    if (cErr) throw new Error(`contacts: ${cErr.message}`)
    const { data: conv, error: vErr } = await service
      .from('conversations')
      .insert({ contact_id: contact.id, channel: 'whatsapp', status: 'closed' })
      .select('id')
      .single<{ id: string }>()
    if (vErr) throw new Error(`conversations: ${vErr.message}`)

    const params = baseParams(phone, sid, 'mensaje en un hilo cerrado')
    const res = await postWebhook(params, sign(params))
    expect(res.status).toBe(200)

    const conversations = await conversationsOf(contact.id)
    expect(conversations.length).toBe(1)
    expect(conversations[0]!.id).toBe(conv.id)
    expect(conversations[0]!.status).toBe('open')

    // El mensaje quedó en ESE hilo, no en uno nuevo.
    const messages = await messagesBySid(sid)
    expect(messages.length).toBe(1)
    expect(messages[0]!.conversation_id).toBe(conv.id)
  })

  // ------------------------------------------------------------------ D

  it('D · una caída de base responde 5xx y no guarda nada; el reintento guarda una vez', async () => {
    const phone = uniquePhone()
    phones.push(phone)
    const sid = uniqueSid()
    const marker = `E2E-CAIDA-${String(Date.now())}`
    const params = baseParams(phone, sid, marker)
    const signature = sign(params)

    // Inyección de fallo: una restricción temporal que rechaza ESTE cuerpo.
    // Es una caída real de almacenamiento (la escritura se revierte) y se
    // levanta en el `finally`, pase lo que pase.
    const constraint = 'e2e_inbound_caida_tmp'
    const pg = new PgClient({ connectionString: DATABASE_URL! })
    await pg.connect()
    try {
      await pg.query(`alter table public.messages drop constraint if exists ${constraint}`)
      await pg.query(
        `alter table public.messages add constraint ${constraint} check (body is distinct from '${marker}')`,
      )

      const failed = await postWebhook(params, signature)
      // 5xx: un fallo temporal se puede reintentar. Un 200 sería un mensaje
      // perdido sin que nadie lo note.
      expect(failed.status).toBeGreaterThanOrEqual(500)
      expect(failed.status).toBeLessThan(600)
      expect(failed.status).not.toBe(200)
    } finally {
      await pg.query(`alter table public.messages drop constraint if exists ${constraint}`)
      await pg.end()
    }

    // No se guardó NADA: ni el mensaje, ni el cliente, ni el hilo.
    expect((await messagesBySid(sid)).length).toBe(0)
    expect(await contactByPhone(phone)).toBeNull()

    // El reintento guarda exactamente un mensaje y un incremento.
    const retried = await postWebhook(params, signature)
    expect(retried.status).toBe(200)

    const messages = await messagesBySid(sid)
    expect(messages.length).toBe(1)

    const contact = await contactByPhone(phone)
    expect(contact).toBeTruthy()
    const conversations = await conversationsOf(contact!.id)
    expect(conversations.length).toBe(1)
    expect(conversations[0]!.unread_count).toBe(1)
  })

  // ------------------------------------------------------------------ E

  it('E · una firma inválida se rechaza con 403 y no escribe nada', async () => {
    const phone = uniquePhone()
    phones.push(phone)
    const sid = uniqueSid()
    const params = baseParams(phone, sid, 'mensaje con firma inválida')

    const res = await postWebhook(params, 'firma-que-no-es-de-twilio')

    expect(res.status).toBe(403)
    expect((await messagesBySid(sid)).length).toBe(0)
    expect(await contactByPhone(phone)).toBeNull()
  })

  // ------------------------------------------------------------------ F

  it('F · un MessageSid repetido no duplica el mensaje ni el contador de no leídos', async () => {
    const phone = uniquePhone()
    phones.push(phone)
    const sid = uniqueSid()
    const params = baseParams(phone, sid, 'mensaje repetido')
    const signature = sign(params)

    const first = await postWebhook(params, signature)
    const second = await postWebhook(params, signature)

    // Un evento ya procesado NO se reintenta: los dos acuses son TwiML vacío.
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)

    expect((await messagesBySid(sid)).length).toBe(1)

    const contact = await contactByPhone(phone)
    const conversations = await conversationsOf(contact!.id)
    expect(conversations.length).toBe(1)
    expect(conversations[0]!.unread_count).toBe(1)
  })

  // ------------------------------------------------------------------ G

  it('G · el acuse a Twilio es TwiML vacío', async () => {
    const phone = uniquePhone()
    phones.push(phone)
    const sid = uniqueSid()
    const params = baseParams(phone, sid, 'mensaje con acuse')
    const res = await postWebhook(params, sign(params))

    expect(res.status).toBe(200)
    expect(res.contentType).toContain('text/xml')
    expect(res.body).toBe(EMPTY_TWIML)
  })

  // ------------------------------------------------------------------ H

  it('H · un MessageSid repetido NO reabre un hilo que el agente cerró', async () => {
    const phone = uniquePhone()
    phones.push(phone)
    const sid = uniqueSid()
    const params = baseParams(phone, sid, 'mensaje antes del cierre')
    const signature = sign(params)

    expect((await postWebhook(params, signature)).status).toBe(200)

    const contact = await contactByPhone(phone)
    const before = await conversationsOf(contact!.id)
    expect(before.length).toBe(1)
    const conversationId = before[0]!.id

    // El agente cierra el hilo.
    const closed = await service
      .from('conversations')
      .update({ status: 'closed' })
      .eq('id', conversationId)
    expect(closed.error).toBeNull()

    // Lega DE NUEVO el mismo mensaje: es un reintento tardío de Twilio, no un
    // mensaje nuevo. No puede insertar nada ni tocar el hilo.
    expect((await postWebhook(params, signature)).status).toBe(200)

    expect((await messagesBySid(sid)).length).toBe(1)
    const after = await conversationsOf(contact!.id)
    expect(after[0]!.unread_count).toBe(1)
    expect(after[0]!.status).toBe('closed')
  })
})

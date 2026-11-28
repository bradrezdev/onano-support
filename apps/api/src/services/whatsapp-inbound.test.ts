import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * E3 · Recepción de WhatsApp — reglas de la firma, del acuse y del fallo.
 *
 * Sin mocks del servicio: el único límite que se falsea es la base (el
 * cliente `service_role`), así que lo que se prueba aquí es el código real
 * de la ruta y del servicio, no su maqueta.
 *
 * Lo que se fija:
 *   · sin credencial → 503 y NADA escrito (la validación nunca se omite).
 *   · firma inválida → 403 y NADA escrito.
 *   · la firma se valida contra la URL PÚBLICA (WEBHOOK_BASE_URL + ruta +
 *     query), no contra `request.url`: detrás de un proxy son distintas.
 *   · la recepción guardada se acusa con TwiML vacío.
 *   · un fallo de almacenamiento responde 5xx, NUNCA 200.
 */

const mockValidateRequest = vi.fn()
vi.mock('twilio', () => {
  const api = {
    validateRequest: (...args: unknown[]) => mockValidateRequest(...args),
  }
  return { default: api, validateRequest: api.validateRequest }
})

const mockRpc = vi.fn()

/**
 * Mock de la consulta a la base: `listConversations` encadena filtros y
 * espera que la promesa se resuelva con la carga útil.
 */
type QueryPayload = { data: unknown; error?: unknown }
type QueryOp = { op: string; args: unknown[] }

class QueryMock {
  ops: QueryOp[] = []
  payload: QueryPayload = { data: [], error: null }

  private record(op: string, args: unknown[]): this {
    this.ops.push({ op, args })
    return this
  }
  select(...args: unknown[]) { return this.record('select', args) }
  eq(col: string, val: unknown) { return this.record('eq', [col, val]) }
  or(filter: string) { return this.record('or', [filter]) }
  in(col: string, vals: unknown[]) { return this.record('in', [col, vals]) }
  order(col: string, opts?: unknown) { return this.record('order', [col, opts]) }
  limit(n: number) { return this.record('limit', [n]) }
  then<T>(onFulfilled: (v: QueryPayload) => T): Promise<T> {
    return Promise.resolve(this.payload).then(onFulfilled)
  }
}

const mockQuery = new QueryMock()

vi.mock('@/lib/supabase/admin', () => ({
  createSupabaseAdminClient: () => ({
    rpc: (...args: unknown[]) => mockRpc(...args),
    from: () => mockQuery,
  }),
}))

const inbound = await import('./whatsapp-inbound')
const { POST, buildPublicWebhookUrl } = await import('@/app/api/webhooks/twilio/route')

const AUTH_TOKEN = 'token-de-prueba'
const PUBLIC_BASE = 'https://api.example.com'

const BASE_FIELDS = {
  From: 'whatsapp:+5491145678901',
  To: 'whatsapp:+14155550001',
  Body: 'hola',
  MessageSid: 'SMabc123',
  NumMedia: '0',
}

const ACCEPTED_ROW = {
  conversation_id: 'c-1',
  message_id: 'm-1',
  contact_id: 'co-1',
  inserted: true,
  status: 'open',
  unread_count: 1,
}

function twilioPost(
  url: string,
  fields: Record<string, string>,
  signature: string | null = 'firma-valida',
): Request {
  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
  }
  if (signature !== null) headers['x-twilio-signature'] = signature
  return new Request(url, {
    method: 'POST',
    body: new URLSearchParams(fields).toString(),
    headers,
  })
}

beforeEach(() => {
  mockRpc.mockReset()
  mockValidateRequest.mockReset()
  mockValidateRequest.mockReturnValue(true)
  mockRpc.mockResolvedValue({ data: [ACCEPTED_ROW], error: null })
  mockQuery.ops = []
  mockQuery.payload = { data: [], error: null }
  process.env.TWILIO_AUTH_TOKEN = AUTH_TOKEN
  process.env.WEBHOOK_BASE_URL = PUBLIC_BASE
})

// ---------------------------------------------------------------------------
// Servicio: la llamada a la función de aceptación
// ---------------------------------------------------------------------------

describe('acceptInboundWhatsApp', () => {
  it('llama a la función de aceptación con el teléfono normalizado', async () => {
    const out = await inbound.acceptInboundWhatsApp({
      from: 'whatsapp:+54 9 11 4567-8901',
      body: 'hola',
      twilio_sid: 'SM1',
    })

    expect(mockRpc).toHaveBeenCalledWith('accept_inbound_whatsapp', {
      p_phone: '+5491145678901',
      p_profile_name: null,
      p_twilio_sid: 'SM1',
      p_body: 'hola',
      p_media_urls: [],
    })
    expect(out.conversation_id).toBe('c-1')
    expect(out.message_id).toBe('m-1')
    expect(out.inserted).toBe(true)
  })

  it('manda el nombre de perfil y los medios cuando vienen', async () => {
    await inbound.acceptInboundWhatsApp({
      from: '+5491145678901',
      body: null,
      twilio_sid: 'SM2',
      profile_name: '  Ana Pérez  ',
      media_urls: ['https://m.example/a.jpg'],
    })

    expect(mockRpc).toHaveBeenCalledWith(
      'accept_inbound_whatsapp',
      expect.objectContaining({
        p_profile_name: 'Ana Pérez',
        p_body: null,
        p_media_urls: ['https://m.example/a.jpg'],
      }),
    )
  })

  it('un error de la base se traduce en un error TEMPORAL (5xx), no en un acuse', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'db down' } })

    await expect(
      inbound.acceptInboundWhatsApp({ from: '+5491145678901', body: 'x', twilio_sid: 'SM3' }),
    ).rejects.toMatchObject({ code: 'storage_unavailable', status: 503 })
  })

  it('un error de VALIDACIÓN de la base se traduce en 400, no en un fallo temporal', async () => {
    // C0011 (teléfono inválido) y C0012 (SID ausente) son de la petición, no
    // de la base: reintentar no arregla nada.
    mockRpc.mockResolvedValue({ data: null, error: { code: 'C0011', message: 'invalid_phone' } })

    await expect(
      inbound.acceptInboundWhatsApp({ from: '+5491145678901', body: 'x', twilio_sid: 'SM6' }),
    ).rejects.toMatchObject({ code: 'invalid_payload', status: 400 })
  })

  it('una respuesta vacía de la base es un error temporal, no un acuse', async () => {
    mockRpc.mockResolvedValue({ data: [], error: null })

    await expect(
      inbound.acceptInboundWhatsApp({ from: '+5491145678901', body: 'x', twilio_sid: 'SM4' }),
    ).rejects.toMatchObject({ code: 'storage_unavailable', status: 503 })
  })

  it('rechaza una recepción sin teléfono o sin SID antes de tocar la base', async () => {
    await expect(
      inbound.acceptInboundWhatsApp({ from: '', body: 'x', twilio_sid: 'SM5' }),
    ).rejects.toMatchObject({ code: 'invalid_payload', status: 400 })
    await expect(
      inbound.acceptInboundWhatsApp({ from: '+5491145678901', body: 'x', twilio_sid: '' }),
    ).rejects.toMatchObject({ code: 'invalid_payload', status: 400 })
    expect(mockRpc).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// La cola: el listado de un agente de soporte TIENE que devolver los chats
// sin titular. Sin esto, el primer mensaje de un cliente nuevo caía en un
// chat invisible para quien trabaja la cola.
// ---------------------------------------------------------------------------

describe('listConversations — la cola del agente de soporte', () => {
  it('incluye los chats sin titular con un OR, sin meter un null en una lista de uuid', async () => {
    const { listConversations } = await import('./conversations')

    await listConversations({ assigned_agent_id: 'u-1', include_unassigned: true })

    const orCall = mockQuery.ops.find((o) => o.op === 'or')
    expect(orCall).toBeDefined()
    expect(orCall!.args[0]).toBe('assigned_agent_id.eq.u-1,assigned_agent_id.is.null')

    // El bug: `in('assigned_agent_id', [id, null])` → Postgres rechaza el null
    // como uuid y el listado respondía 500.
    expect(mockQuery.ops.some((o) => o.op === 'in')).toBe(false)
  })

  it('sin la cola, filtra solo por el titular', async () => {
    const { listConversations } = await import('./conversations')

    await listConversations({ assigned_agent_id: 'u-1' })

    const eqCall = mockQuery.ops.find((o) => o.op === 'eq')
    expect(eqCall!.args).toEqual(['assigned_agent_id', 'u-1'])
    expect(mockQuery.ops.some((o) => o.op === 'or' || o.op === 'in')).toBe(false)
  })

  it('para la administración (sin titular) no aplica ningún filtro de titular', async () => {
    const { listConversations } = await import('./conversations')

    await listConversations({})

    expect(mockQuery.ops.some((o) => o.op === 'or' || o.op === 'in')).toBe(false)
    expect(mockQuery.ops.some((o) => o.op === 'eq')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// La URL que se valida: la pública, no la interna
// ---------------------------------------------------------------------------

describe('buildPublicWebhookUrl', () => {
  it('usa el origen público, la ruta y el query string', () => {
    const request = new Request('http://localhost:3000/api/webhooks/twilio?foo=bar')
    expect(buildPublicWebhookUrl(request, PUBLIC_BASE)).toBe(
      'https://api.example.com/api/webhooks/twilio?foo=bar',
    )
  })

  it('ignora el fragmento: los overrides de conexión no entran en la firma', () => {
    const request = new Request('http://localhost:3000/api/webhooks/twilio')
    expect(buildPublicWebhookUrl(request, 'https://api.example.com/#rc=3&rp=5xx,ct,rt')).toBe(
      'https://api.example.com/api/webhooks/twilio',
    )
  })

  it('tolera una base con barra final', () => {
    const request = new Request('http://localhost:3000/api/webhooks/twilio')
    expect(buildPublicWebhookUrl(request, 'https://api.example.com/')).toBe(
      'https://api.example.com/api/webhooks/twilio',
    )
  })
})

// ---------------------------------------------------------------------------
// Ruta: credencial, firma, acuse y fallo
// ---------------------------------------------------------------------------

describe('POST /api/webhooks/twilio', () => {
  it('sin credencial responde 503 y NO escribe nada', async () => {
    delete process.env.TWILIO_AUTH_TOKEN

    const res = await POST(twilioPost('http://localhost:3000/api/webhooks/twilio', BASE_FIELDS))

    expect(res.status).toBe(503)
    expect(mockValidateRequest).not.toHaveBeenCalled()
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('sin URL pública configurada responde 503 y NO escribe nada', async () => {
    delete process.env.WEBHOOK_BASE_URL

    const res = await POST(twilioPost('http://localhost:3000/api/webhooks/twilio', BASE_FIELDS))

    expect(res.status).toBe(503)
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('una firma inválida responde 403 y NO escribe nada', async () => {
    mockValidateRequest.mockReturnValue(false)

    const res = await POST(
      twilioPost('http://localhost:3000/api/webhooks/twilio', BASE_FIELDS, 'firma-falsa'),
    )

    expect(res.status).toBe(403)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe('invalid_signature')
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('sin cabecera de firma responde 403 y NO escribe nada', async () => {
    const res = await POST(
      twilioPost('http://localhost:3000/api/webhooks/twilio', BASE_FIELDS, null),
    )

    expect(res.status).toBe(403)
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('valida la firma contra la URL PÚBLICA, no contra request.url', async () => {
    // Detrás de un proxy, `request.url` es la URL interna: validar contra
    // ella rechazaría toda petición legítima con 403.
    const res = await POST(twilioPost('http://localhost:3000/api/webhooks/twilio', BASE_FIELDS))

    expect(res.status).toBe(200)
    expect(mockValidateRequest).toHaveBeenCalledWith(
      AUTH_TOKEN,
      'firma-valida',
      'https://api.example.com/api/webhooks/twilio',
      expect.objectContaining({ MessageSid: 'SMabc123' }),
    )
  })

  it('una recepción guardada se acusa con TwiML vacío', async () => {
    const res = await POST(twilioPost('http://localhost:3000/api/webhooks/twilio', BASE_FIELDS))

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/xml')
    expect(await res.text()).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><Response></Response>',
    )
    expect(mockRpc).toHaveBeenCalledTimes(1)
  })

  it('pasa el teléfono, el cuerpo, el SID y los medios a la aceptación', async () => {
    await POST(
      twilioPost('http://localhost:3000/api/webhooks/twilio', {
        ...BASE_FIELDS,
        NumMedia: '2',
        MediaUrl0: 'https://m.example/a.jpg',
        MediaUrl1: 'https://m.example/b.jpg',
      }),
    )

    expect(mockRpc).toHaveBeenCalledWith(
      'accept_inbound_whatsapp',
      expect.objectContaining({
        p_phone: '+5491145678901',
        p_body: 'hola',
        p_twilio_sid: 'SMabc123',
        p_media_urls: ['https://m.example/a.jpg', 'https://m.example/b.jpg'],
      }),
    )
  })

  it('un fallo de almacenamiento responde 5xx, NUNCA 200', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'db down' } })
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const res = await POST(twilioPost('http://localhost:3000/api/webhooks/twilio', BASE_FIELDS))

    expect(res.status).toBeGreaterThanOrEqual(500)
    expect(res.status).toBeLessThan(600)
    expect(res.status).not.toBe(200)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe('storage_unavailable')
    errSpy.mockRestore()
  })

  it('una carga incompleta responde 400 y NO escribe nada', async () => {
    const { MessageSid, ...rest } = BASE_FIELDS
    void MessageSid

    const res = await POST(twilioPost('http://localhost:3000/api/webhooks/twilio', rest))

    expect(res.status).toBe(400)
    expect(mockRpc).not.toHaveBeenCalled()
  })
})

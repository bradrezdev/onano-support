import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * E3 · Webhook entrante de WhatsApp — el contrato actual.
 *
 * El límite que se falsea es la BASE (`service_role`): la ruta y el servicio
 * se ejecutan de verdad, así que lo que se afirma aquí es el comportamiento
 * observable, no una maqueta.
 *
 * Las reglas fijadas:
 *   · sin `TWILIO_AUTH_TOKEN` → 503 y NADA escrito (la validación nunca se
 *     omite: una entrada externa sin credencial no se acepta).
 *   · sin `WEBHOOK_BASE_URL` → 503 y NADA escrito: sin la URL pública no se
 *     puede saber qué firmó Twilio.
 *   · firma inválida (o ausente) → 403 y NADA escrito.
 *   · la firma se valida contra la URL PÚBLICA, no contra `request.url`.
 *   · la recepción guardada se acusa con TwiML vacío.
 *   · el cliente desconocido NO se descarta: se crea y su chat entra en la cola.
 *   · un `MessageSid` repetido se acusa con TwiML vacío y no duplica nada.
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
vi.mock('@/lib/supabase/admin', () => ({
  createSupabaseAdminClient: () => ({
    rpc: (...args: unknown[]) => mockRpc(...args),
  }),
}))

const { POST } = await import('./route')

const AUTH_TOKEN = 'token-de-prueba'
const PUBLIC_BASE = 'https://api.example.com'
const REQUEST_URL = 'http://localhost:3000/api/webhooks/twilio'
const PUBLIC_URL = 'https://api.example.com/api/webhooks/twilio'
const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>'

const BASE_FIELDS = {
  From: 'whatsapp:+5491145678901',
  To: 'whatsapp:+14155550001',
  Body: 'hola',
  MessageSid: 'SMabc123',
  NumMedia: '0',
}

/** Lo que devuelve la función de aceptación cuando el mensaje es nuevo. */
const ACCEPTED = {
  conversation_id: 'c-1',
  message_id: 'm-1',
  contact_id: 'co-1',
  inserted: true,
  status: 'open',
  unread_count: 1,
}

/** Lo que devuelve cuando el `MessageSid` ya estaba guardado. */
const ALREADY_STORED = { ...ACCEPTED, message_id: 'm-0', inserted: false, unread_count: 1 }

function twilioPost(
  fields: Record<string, string>,
  signature: string | null = 'firma-valida',
  url: string = REQUEST_URL,
): Request {
  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
  }
  if (signature !== null) headers['x-twilio-signature'] = signature
  return new Request(url, { method: 'POST', body: new URLSearchParams(fields).toString(), headers })
}

beforeEach(() => {
  mockRpc.mockReset()
  mockValidateRequest.mockReset()
  mockValidateRequest.mockReturnValue(true)
  mockRpc.mockResolvedValue({ data: [ACCEPTED], error: null })
  process.env.TWILIO_AUTH_TOKEN = AUTH_TOKEN
  process.env.WEBHOOK_BASE_URL = PUBLIC_BASE
})

// ---------------------------------------------------------------------------
// Credencial y URL pública: se rechaza ANTES de escribir
// ---------------------------------------------------------------------------

describe('POST /api/webhooks/twilio — sin credencial', () => {
  it('sin TWILIO_AUTH_TOKEN responde 503 y NO escribe nada', async () => {
    delete process.env.TWILIO_AUTH_TOKEN

    const res = await POST(twilioPost(BASE_FIELDS))

    expect(res.status).toBe(503)
    expect(mockValidateRequest).not.toHaveBeenCalled()
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('sin WEBHOOK_BASE_URL responde 503 y NO escribe nada', async () => {
    delete process.env.WEBHOOK_BASE_URL

    const res = await POST(twilioPost(BASE_FIELDS))

    expect(res.status).toBe(503)
    expect(mockRpc).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Firma
// ---------------------------------------------------------------------------

describe('POST /api/webhooks/twilio — firma', () => {
  it('una firma inválida responde 403 y NO escribe nada', async () => {
    mockValidateRequest.mockReturnValue(false)

    const res = await POST(twilioPost(BASE_FIELDS, 'firma-falsa'))

    expect(res.status).toBe(403)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe('invalid_signature')
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('sin cabecera de firma responde 403 y NO escribe nada', async () => {
    const res = await POST(twilioPost(BASE_FIELDS, null))

    expect(res.status).toBe(403)
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('valida la firma contra la URL PÚBLICA, no contra request.url', async () => {
    // Detrás de un proxy, `request.url` es la URL interna: validar contra
    // ella rechazaría toda petición legítima con 403.
    const res = await POST(twilioPost(BASE_FIELDS))

    expect(res.status).toBe(200)
    expect(mockValidateRequest).toHaveBeenCalledWith(
      AUTH_TOKEN,
      'firma-valida',
      PUBLIC_URL,
      expect.objectContaining({ MessageSid: 'SMabc123' }),
    )
  })
})

// ---------------------------------------------------------------------------
// Recepción guardada: el acuse es TwiML vacío
// ---------------------------------------------------------------------------

describe('POST /api/webhooks/twilio — recepción', () => {
  it('la recepción guardada se acusa con TwiML vacío', async () => {
    const res = await POST(twilioPost(BASE_FIELDS))

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/xml')
    expect(await res.text()).toBe(EMPTY_TWIML)
    expect(mockRpc).toHaveBeenCalledTimes(1)
  })

  it('el cliente desconocido NO se descarta: se crea y su chat entra en la cola', async () => {
    // Antes respondía 200 { skipped: 'unknown_contact' } y el mensaje se
    // perdía. Ahora la aceptación crea al cliente y abre su hilo.
    const res = await POST(twilioPost(BASE_FIELDS))

    expect(res.status).toBe(200)
    expect(mockRpc).toHaveBeenCalledWith(
      'accept_inbound_whatsapp',
      expect.objectContaining({ p_phone: '+5491145678901', p_twilio_sid: 'SMabc123' }),
    )
    expect(await res.text()).not.toContain('unknown_contact')
  })

  it('un MessageSid repetido se acusa con TwiML vacío y no duplica nada', async () => {
    mockRpc.mockResolvedValue({ data: [ALREADY_STORED], error: null })

    const res = await POST(twilioPost(BASE_FIELDS))

    expect(res.status).toBe(200)
    expect(await res.text()).toBe(EMPTY_TWIML)
    // La base decide: no insertó, y la ruta no lo reintenta ni inventa otro.
    expect(mockRpc).toHaveBeenCalledTimes(1)
  })

  it('los medios se pasan a la aceptación', async () => {
    await POST(
      twilioPost({
        ...BASE_FIELDS,
        NumMedia: '2',
        MediaUrl0: 'https://m.example/a.jpg',
        MediaUrl1: 'https://m.example/b.jpg',
      }),
    )

    expect(mockRpc).toHaveBeenCalledWith(
      'accept_inbound_whatsapp',
      expect.objectContaining({
        p_media_urls: ['https://m.example/a.jpg', 'https://m.example/b.jpg'],
      }),
    )
  })

  it('sin Body el mensaje se guarda con cuerpo null', async () => {
    const { Body, ...rest } = BASE_FIELDS
    void Body

    await POST(twilioPost(rest))

    expect(mockRpc).toHaveBeenCalledWith(
      'accept_inbound_whatsapp',
      expect.objectContaining({ p_body: null }),
    )
  })

  it('una carga incompleta responde 400 y NO escribe nada', async () => {
    const { From, ...rest } = BASE_FIELDS
    void From

    const res = await POST(twilioPost(rest))

    expect(res.status).toBe(400)
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('sin MessageSid responde 400 y NO escribe nada', async () => {
    const { MessageSid, ...rest } = BASE_FIELDS
    void MessageSid

    const res = await POST(twilioPost(rest))

    expect(res.status).toBe(400)
    expect(mockRpc).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Fallo de almacenamiento: 5xx, nunca 200
// ---------------------------------------------------------------------------

describe('POST /api/webhooks/twilio — fallo de almacenamiento', () => {
  it('un fallo de almacenamiento responde 5xx, NUNCA 200', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'db down' } })
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const res = await POST(twilioPost(BASE_FIELDS))

    expect(res.status).toBeGreaterThanOrEqual(500)
    expect(res.status).toBeLessThan(600)
    expect(res.status).not.toBe(200)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe('storage_unavailable')
    expect(errSpy).toHaveBeenCalled()
    errSpy.mockRestore()
  })
})

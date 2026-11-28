import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * E3 · Callback de estado de Twilio — el contrato actual.
 *
 * El límite que se falsea es la BASE: la ruta y el servicio se ejecutan de
 * verdad. Las reglas fijadas:
 *   · sin `TWILIO_AUTH_TOKEN` → 503 y NADA escrito (la validación nunca se
 *     omite).
 *   · sin `WEBHOOK_BASE_URL` → 503 y NADA escrito.
 *   · firma inválida → 403 y NADA escrito.
 *   · la firma se valida contra la URL PÚBLICA, no contra `request.url`.
 *   · un `MessageSid` o un estado que no sirven no se tocan (200 + skip).
 *   · un fallo de almacenamiento responde 5xx, NUNCA 200: un estado perdido
 *     no se puede recuperar si se acusa con 200.
 */

const mockValidateRequest = vi.fn()
vi.mock('twilio', () => {
  const api = {
    validateRequest: (...args: unknown[]) => mockValidateRequest(...args),
  }
  return { default: api, validateRequest: api.validateRequest }
})

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
  update(rows: unknown) { return this.record('update', [rows]) }
  eq(col: string, val: unknown) { return this.record('eq', [col, val]) }
  then<T>(onFulfilled: (v: QueryPayload) => T): Promise<T> {
    return Promise.resolve(this.payload).then(onFulfilled)
  }
}

const mockQuery = new QueryMock()

vi.mock('@/lib/supabase/admin', () => ({
  createSupabaseAdminClient: () => ({ from: () => mockQuery }),
}))

const { POST } = await import('./route')

const AUTH_TOKEN = 'token-de-prueba'
const PUBLIC_BASE = 'https://api.example.com'
const REQUEST_URL = 'http://localhost:3000/api/webhooks/twilio/status'
const PUBLIC_URL = 'https://api.example.com/api/webhooks/twilio/status'

const ALLOWED_STATUSES = ['queued', 'sent', 'delivered', 'read', 'failed'] as const

function twilioPost(
  fields: Record<string, string>,
  signature: string | null = 'firma-valida',
): Request {
  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
  }
  if (signature !== null) headers['x-twilio-signature'] = signature
  return new Request(REQUEST_URL, {
    method: 'POST',
    body: new URLSearchParams(fields).toString(),
    headers,
  })
}

beforeEach(() => {
  mockQuery.ops = []
  mockQuery.payload = { data: [{ id: 'm-1' }], error: null }
  mockValidateRequest.mockReset()
  mockValidateRequest.mockReturnValue(true)
  process.env.TWILIO_AUTH_TOKEN = AUTH_TOKEN
  process.env.WEBHOOK_BASE_URL = PUBLIC_BASE
})

// ---------------------------------------------------------------------------
// Credencial y URL pública
// ---------------------------------------------------------------------------

describe('POST /api/webhooks/twilio/status — sin credencial', () => {
  it('sin TWILIO_AUTH_TOKEN responde 503 y NO escribe nada', async () => {
    delete process.env.TWILIO_AUTH_TOKEN

    const res = await POST(twilioPost({ MessageSid: 'SMabc', MessageStatus: 'delivered' }))

    expect(res.status).toBe(503)
    expect(mockValidateRequest).not.toHaveBeenCalled()
    expect(mockQuery.ops.some((o) => o.op === 'update')).toBe(false)
  })

  it('sin WEBHOOK_BASE_URL responde 503 y NO escribe nada', async () => {
    delete process.env.WEBHOOK_BASE_URL

    const res = await POST(twilioPost({ MessageSid: 'SMabc', MessageStatus: 'delivered' }))

    expect(res.status).toBe(503)
    expect(mockQuery.ops.some((o) => o.op === 'update')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Firma
// ---------------------------------------------------------------------------

describe('POST /api/webhooks/twilio/status — firma', () => {
  it('una firma inválida responde 403 y NO escribe nada', async () => {
    mockValidateRequest.mockReturnValue(false)

    const res = await POST(
      twilioPost({ MessageSid: 'SMabc', MessageStatus: 'delivered' }, 'firma-falsa'),
    )

    expect(res.status).toBe(403)
    expect(mockQuery.ops.some((o) => o.op === 'update')).toBe(false)
  })

  it('valida la firma contra la URL PÚBLICA, no contra request.url', async () => {
    const res = await POST(twilioPost({ MessageSid: 'SMabc', MessageStatus: 'delivered' }))

    expect(res.status).toBe(200)
    expect(mockValidateRequest).toHaveBeenCalledWith(
      AUTH_TOKEN,
      'firma-valida',
      PUBLIC_URL,
      expect.objectContaining({ MessageSid: 'SMabc' }),
    )
  })
})

// ---------------------------------------------------------------------------
// Validación de la carga
// ---------------------------------------------------------------------------

describe('POST /api/webhooks/twilio/status — carga', () => {
  it('sin MessageSid no toca nada y lo dice', async () => {
    const res = await POST(twilioPost({ MessageStatus: 'delivered' }))

    expect(res.status).toBe(200)
    const body = (await res.json()) as { skipped: string }
    expect(body.skipped).toContain('sid')
    expect(mockQuery.ops.some((o) => o.op === 'update')).toBe(false)
  })

  it('con un estado fuera del enum no toca nada y lo dice', async () => {
    const res = await POST(twilioPost({ MessageSid: 'SMabc', MessageStatus: 'algo_raro' }))

    expect(res.status).toBe(200)
    const body = (await res.json()) as { skipped: string }
    expect(body.skipped).toContain('status')
    expect(mockQuery.ops.some((o) => o.op === 'update')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Camino feliz
// ---------------------------------------------------------------------------

describe('POST /api/webhooks/twilio/status — estados', () => {
  it('acepta todos los estados válidos y los escribe', async () => {
    for (const status of ALLOWED_STATUSES) {
      mockQuery.ops = []
      const res = await POST(twilioPost({ MessageSid: 'SMabc', MessageStatus: status }))

      expect(res.status).toBe(200)
      const update = mockQuery.ops.find((o) => o.op === 'update')
      expect(update!.args[0]).toEqual({ twilio_status: status })
      const eqCall = mockQuery.ops.find((o) => o.op === 'eq')
      expect(eqCall!.args).toEqual(['twilio_sid', 'SMabc'])
    }
  })

  it('informa si actualizó el mensaje', async () => {
    const res = await POST(twilioPost({ MessageSid: 'SMabc', MessageStatus: 'read' }))

    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; updated: boolean }
    expect(body.updated).toBe(true)
  })

  it('informa cuando no encontró el mensaje', async () => {
    mockQuery.payload = { data: [], error: null }

    const res = await POST(twilioPost({ MessageSid: 'SMmissing', MessageStatus: 'failed' }))

    const body = (await res.json()) as { updated: boolean }
    expect(body.updated).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Fallo de almacenamiento: 5xx, nunca 200
// ---------------------------------------------------------------------------

describe('POST /api/webhooks/twilio/status — fallo de almacenamiento', () => {
  it('un fallo de almacenamiento responde 5xx, NUNCA 200', async () => {
    mockQuery.payload = { data: null, error: { message: 'db down' } }
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const res = await POST(twilioPost({ MessageSid: 'SMabc', MessageStatus: 'failed' }))

    expect(res.status).toBeGreaterThanOrEqual(500)
    expect(res.status).toBeLessThan(600)
    expect(res.status).not.toBe(200)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe('storage_unavailable')
    expect(errSpy).toHaveBeenCalled()
    errSpy.mockRestore()
  })
})

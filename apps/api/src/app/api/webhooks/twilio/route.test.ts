import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Mock the conversation service to control the full webhook flow per test.
const mockFindContact = vi.fn()
const mockFindOrCreate = vi.fn()
const mockAppendInbound = vi.fn()

vi.mock('@/services/conversations', () => ({
  findContactByWhatsappNumber: (...args: unknown[]) => mockFindContact(...args),
  findOrCreateConversationForContact: (...args: unknown[]) => mockFindOrCreate(...args),
  appendInboundMessage: (...args: unknown[]) => mockAppendInbound(...args),
}))

// Auth token is read from process.env; tests set it per case.
const { POST } = await import('./route')

beforeEach(() => {
  mockFindContact.mockReset()
  mockFindOrCreate.mockReset()
  mockAppendInbound.mockReset()
})

// Build a Twilio-style POST with x-www-form-urlencoded body.
function twilioPost(url: string, fields: Record<string, string>, signature?: string) {
  const body = new URLSearchParams(fields).toString()
  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
  }
  if (signature) headers['x-twilio-signature'] = signature
  return new Request(url, { method: 'POST', body, headers })
}

const WEBHOOK_URL = 'http://x/api/webhooks/twilio'
const BASE_FIELDS = {
  From: 'whatsapp:+5491145678901',
  To: 'whatsapp:+14155550001',
  Body: 'hola',
  MessageSid: 'SMabc123',
  NumMedia: '0',
}

// ---------------------------------------------------------------------------
// Signature
// ---------------------------------------------------------------------------

describe('POST /api/webhooks/twilio — signature', () => {
  beforeEach(() => {
    // Dev mode: no TWILIO_AUTH_TOKEN env var → signature check is skipped.
    delete process.env.TWILIO_AUTH_TOKEN
  })

  it('returns 403 invalid_signature when TWILIO_AUTH_TOKEN is set and signature mismatches', async () => {
    process.env.TWILIO_AUTH_TOKEN = 'real-token'
    mockFindContact.mockResolvedValue({ id: 'co-1' })
    const res = await POST(twilioPost(WEBHOOK_URL, BASE_FIELDS, 'bogus'))
    expect(res.status).toBe(403)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe('invalid_signature')
    expect(mockFindContact).not.toHaveBeenCalled()
  })

  it('skips signature check in dev mode (no token) and processes the message', async () => {
    mockFindContact.mockResolvedValue({ id: 'co-1' })
    mockFindOrCreate.mockResolvedValue({ id: 'c-1' })
    mockAppendInbound.mockResolvedValue({ id: 'm-1' })
    const res = await POST(twilioPost(WEBHOOK_URL, BASE_FIELDS))
    expect(res.status).toBe(200)
    expect(mockFindContact).toHaveBeenCalledWith('whatsapp:+5491145678901')
  })
})

// ---------------------------------------------------------------------------
// Skip paths
// ---------------------------------------------------------------------------

describe('POST /api/webhooks/twilio — skip paths (always 200)', () => {
  beforeEach(() => {
    delete process.env.TWILIO_AUTH_TOKEN
  })

  it('returns 200 ok:skipped when From is missing', async () => {
    const { From, ...rest } = BASE_FIELDS
    void From
    const res = await POST(twilioPost(WEBHOOK_URL, rest))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; skipped: string }
    expect(body.ok).toBe(true)
    expect(body.skipped).toContain('missing')
    expect(mockFindContact).not.toHaveBeenCalled()
  })

  it('returns 200 ok:skipped when MessageSid is missing', async () => {
    const { MessageSid, ...rest } = BASE_FIELDS
    void MessageSid
    const res = await POST(twilioPost(WEBHOOK_URL, rest))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; skipped: string }
    expect(body.skipped).toContain('missing')
  })

  it('returns 200 ok:skipped unknown_contact when contact is not in CRM', async () => {
    mockFindContact.mockResolvedValue(null)
    const res = await POST(twilioPost(WEBHOOK_URL, BASE_FIELDS))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; skipped: string; from: string }
    expect(body.skipped).toBe('unknown_contact')
    expect(body.from).toBe('whatsapp:+5491145678901')
    expect(mockFindOrCreate).not.toHaveBeenCalled()
    expect(mockAppendInbound).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('POST /api/webhooks/twilio — happy path', () => {
  beforeEach(() => {
    delete process.env.TWILIO_AUTH_TOKEN
  })

  it('finds contact, finds-or-creates conversation, appends message idempotently', async () => {
    mockFindContact.mockResolvedValue({ id: 'co-1', whatsapp_number: '+5491145678901', name: 'Alice' })
    mockFindOrCreate.mockResolvedValue({ id: 'c-1', contact_id: 'co-1' })
    mockAppendInbound.mockResolvedValue({ id: 'm-1' })
    const res = await POST(twilioPost(WEBHOOK_URL, BASE_FIELDS))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; conversation_id: string }
    expect(body.ok).toBe(true)
    expect(body.conversation_id).toBe('c-1')
    expect(mockAppendInbound).toHaveBeenCalledWith({
      conversation_id: 'c-1',
      body: 'hola',
      twilio_sid: 'SMabc123',
      media_urls: [],
    })
  })

  it('passes media_urls when NumMedia > 0', async () => {
    mockFindContact.mockResolvedValue({ id: 'co-1' })
    mockFindOrCreate.mockResolvedValue({ id: 'c-1' })
    mockAppendInbound.mockResolvedValue({ id: 'm-1' })
    const res = await POST(
      twilioPost(WEBHOOK_URL, {
        ...BASE_FIELDS,
        NumMedia: '2',
        MediaUrl0: 'https://m.example/a.jpg',
        MediaUrl1: 'https://m.example/b.jpg',
      }),
    )
    expect(res.status).toBe(200)
    const call = mockAppendInbound.mock.calls[0]![0] as { media_urls: string[] }
    expect(call.media_urls).toEqual(['https://m.example/a.jpg', 'https://m.example/b.jpg'])
  })

  it('passes null body when Body is missing', async () => {
    mockFindContact.mockResolvedValue({ id: 'co-1' })
    mockFindOrCreate.mockResolvedValue({ id: 'c-1' })
    mockAppendInbound.mockResolvedValue({ id: 'm-1' })
    const { Body, ...rest } = BASE_FIELDS
    void Body
    const res = await POST(twilioPost(WEBHOOK_URL, rest))
    expect(res.status).toBe(200)
    const call = mockAppendInbound.mock.calls[0]![0] as { body: string | null }
    expect(call.body).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Failure path (always 200 to Twilio)
// ---------------------------------------------------------------------------

describe('POST /api/webhooks/twilio — error swallowing (always 200)', () => {
  beforeEach(() => {
    delete process.env.TWILIO_AUTH_TOKEN
  })

  it('returns 200 with error message when service throws', async () => {
    mockFindContact.mockResolvedValue({ id: 'co-1' })
    mockFindOrCreate.mockRejectedValue(new Error('db down'))
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const res = await POST(twilioPost(WEBHOOK_URL, BASE_FIELDS))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; error: string }
    expect(body.ok).toBe(true)
    expect(body.error).toBe('db down')
    expect(errSpy).toHaveBeenCalled()
    errSpy.mockRestore()
  })
})

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockUpdate = vi.fn()
vi.mock('@/services/conversations', () => ({
  updateMessageStatusBySid: (...args: unknown[]) => mockUpdate(...args),
}))

const { POST } = await import('./route')

beforeEach(() => {
  mockUpdate.mockReset()
  delete process.env.TWILIO_AUTH_TOKEN
})

const URL = 'http://x/api/webhooks/twilio/status'

function twilioPost(fields: Record<string, string>, signature?: string) {
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' }
  if (signature) headers['x-twilio-signature'] = signature
  return new Request(URL, { method: 'POST', body: new URLSearchParams(fields).toString(), headers })
}

describe('POST /api/webhooks/twilio/status — signature', () => {
  it('returns 403 invalid_signature when TWILIO_AUTH_TOKEN is set and signature mismatches', async () => {
    process.env.TWILIO_AUTH_TOKEN = 'real'
    const res = await POST(twilioPost({ MessageSid: 'SMabc', MessageStatus: 'delivered' }, 'bogus'))
    expect(res.status).toBe(403)
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('proceeds without signature in dev mode', async () => {
    mockUpdate.mockResolvedValue({ updated: true })
    const res = await POST(twilioPost({ MessageSid: 'SMabc', MessageStatus: 'delivered' }))
    expect(res.status).toBe(200)
  })
})

describe('POST /api/webhooks/twilio/status — validation', () => {
  it('skips when MessageSid is missing', async () => {
    const res = await POST(twilioPost({ MessageStatus: 'delivered' }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { skipped: string }
    expect(body.skipped).toContain('sid')
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('skips when MessageStatus is not in the allowed enum', async () => {
    const res = await POST(twilioPost({ MessageSid: 'SMabc', MessageStatus: 'something_random' }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { skipped: string }
    expect(body.skipped).toContain('status')
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('accepts every allowed status', async () => {
    mockUpdate.mockResolvedValue({ updated: true })
    for (const status of ['queued', 'sent', 'delivered', 'read', 'failed']) {
      mockUpdate.mockClear()
      const res = await POST(twilioPost({ MessageSid: 'SMabc', MessageStatus: status }))
      expect(res.status).toBe(200)
      expect(mockUpdate).toHaveBeenCalledWith('SMabc', status)
    }
  })
})

describe('POST /api/webhooks/twilio/status — happy + error', () => {
  it('reports updated flag from the service', async () => {
    mockUpdate.mockResolvedValue({ updated: true })
    const res = await POST(twilioPost({ MessageSid: 'SMabc', MessageStatus: 'read' }))
    const body = (await res.json()) as { ok: boolean; updated: boolean }
    expect(body.updated).toBe(true)
  })

  it('reports updated: false when service could not match', async () => {
    mockUpdate.mockResolvedValue({ updated: false })
    const res = await POST(twilioPost({ MessageSid: 'SMmissing', MessageStatus: 'failed' }))
    const body = (await res.json()) as { updated: boolean }
    expect(body.updated).toBe(false)
  })

  it('returns 200 with error message on service exception (Twilio retry avoidance)', async () => {
    mockUpdate.mockRejectedValue(new Error('db down'))
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const res = await POST(twilioPost({ MessageSid: 'SMabc', MessageStatus: 'failed' }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; error: string }
    expect(body.ok).toBe(true)
    expect(body.error).toBe('db down')
    errSpy.mockRestore()
  })
})

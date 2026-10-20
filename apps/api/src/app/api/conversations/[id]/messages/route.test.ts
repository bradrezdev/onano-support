import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockRequireRole = vi.fn()
const mockAppendOutbound = vi.fn()

vi.mock('@/lib/auth', () => ({
  requireUser: vi.fn(),
  requireRole: (...args: unknown[]) => mockRequireRole(...args),
  getCurrentUser: vi.fn(),
}))

vi.mock('@/services/conversations', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/conversations')>()
  return {
    ...actual,
    appendOutboundMessage: (...args: unknown[]) => mockAppendOutbound(...args),
  }
})

const { POST } = await import('./route')

beforeEach(() => {
  mockRequireRole.mockReset()
  mockAppendOutbound.mockReset()
})

function okAuth(role: 'admin' | 'supervisor' | 'soporte' = 'soporte', id = 'u-1') {
  return mockRequireRole.mockResolvedValue({
    user: {
      id,
      email: `${id}@x`,
      role,
      display_name: 'X',
      suspended_at: null,
      deleted_at: null,
    },
  })
}

function denyAuth(status: number, code: string, message: string) {
  const { NextResponse } = require('next/server') as typeof import('next/server')
  return mockRequireRole.mockResolvedValue({
    error: NextResponse.json({ code, error: code, message }, { status }),
  })
}

const ctx = (id: string) => ({ params: Promise.resolve({ id }) })

function postReq(body: unknown) {
  return new Request('http://x/api/conversations/c-1/messages', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })
}

describe('POST /api/conversations/[id]/messages — auth', () => {
  it('returns 401 when unauthorized', async () => {
    denyAuth(401, 'unauthorized', 'Not signed in')
    const res = await POST(postReq({ body: 'hi' }), ctx('c-1'))
    expect(res.status).toBe(401)
    expect(mockAppendOutbound).not.toHaveBeenCalled()
  })

  it('allows admin, supervisor, soporte (all three)', async () => {
    for (const role of ['admin', 'supervisor', 'soporte'] as const) {
      mockRequireRole.mockReset()
      mockAppendOutbound.mockReset()
      okAuth(role)
      mockAppendOutbound.mockResolvedValue({ id: 'm-1' })
      const res = await POST(postReq({ body: 'hi' }), ctx('c-1'))
      expect(res.status).toBe(201)
    }
  })
})

describe('POST /api/conversations/[id]/messages — Zod', () => {
  it('returns 400 invalid_json when body is not parseable', async () => {
    okAuth()
    const req = new Request('http://x/api/conversations/c-1/messages', {
      method: 'POST',
      body: '{not json',
    })
    const res = await POST(req, ctx('c-1'))
    expect(res.status).toBe(400)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe('invalid_json')
  })

  it('returns 400 validation_failed when body is missing', async () => {
    okAuth()
    const res = await POST(postReq({}), ctx('c-1'))
    expect(res.status).toBe(400)
    const body = (await res.json()) as { code: string; details: Array<{ path: string }> }
    expect(body.code).toBe('validation_failed')
    expect(body.details[0]!.path).toBe('body')
  })

  it('returns 400 validation_failed when body is empty string', async () => {
    okAuth()
    const res = await POST(postReq({ body: '' }), ctx('c-1'))
    expect(res.status).toBe(400)
  })

  it('returns 400 validation_failed when body exceeds 4096 chars', async () => {
    okAuth()
    const res = await POST(postReq({ body: 'x'.repeat(4097) }), ctx('c-1'))
    expect(res.status).toBe(400)
  })

  it('accepts body exactly at the 4096 limit', async () => {
    okAuth()
    mockAppendOutbound.mockResolvedValue({ id: 'm-1' })
    const res = await POST(postReq({ body: 'x'.repeat(4096) }), ctx('c-1'))
    expect(res.status).toBe(201)
  })
})

describe('POST /api/conversations/[id]/messages — happy path', () => {
  it('returns 201 with the inserted message', async () => {
    okAuth('soporte', 'u-actor')
    mockAppendOutbound.mockResolvedValue({
      id: 'm-1',
      conversation_id: 'c-1',
      direction: 'out',
      body: 'hola',
      media_urls: null,
      twilio_sid: null,
      twilio_status: null,
      sent_by_id: 'u-actor',
      created_at: '2026-01-01',
    })
    const res = await POST(postReq({ body: 'hola' }), ctx('c-1'))
    expect(res.status).toBe(201)
    const body = (await res.json()) as { data: { id: string; sent_by_id: string } }
    expect(body.data.id).toBe('m-1')
    expect(body.data.sent_by_id).toBe('u-actor')
    expect(mockAppendOutbound).toHaveBeenCalledWith({
      conversation_id: 'c-1',
      body: 'hola',
      sent_by_id: 'u-actor',
    })
  })
})

describe('POST /api/conversations/[id]/messages — error mapping', () => {
  it('maps ConversationError to its declared status', async () => {
    okAuth()
    const { ConversationError } = await import('@/services/conversations')
    mockAppendOutbound.mockRejectedValue(new ConversationError('forbidden', 'nope', 403))
    const res = await POST(postReq({ body: 'hi' }), ctx('c-1'))
    expect(res.status).toBe(403)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe('forbidden')
  })

  it('returns 500 db_error for non-ConversationError exceptions', async () => {
    okAuth()
    mockAppendOutbound.mockRejectedValue(new Error('connect ECONNREFUSED'))
    const res = await POST(postReq({ body: 'hi' }), ctx('c-1'))
    expect(res.status).toBe(500)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe('db_error')
  })
})

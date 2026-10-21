import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockRequireRole = vi.fn()
const mockListLinked = vi.fn()
const mockLink = vi.fn()

vi.mock('@/lib/auth', () => ({
  requireUser: vi.fn(),
    requirePermission: (...args: unknown[]) => mockRequireRole(...args),
  requireAllPermissions: (...args: unknown[]) => mockRequireRole(...args),requireRole: (...args: unknown[]) => mockRequireRole(...args),
  getCurrentUser: vi.fn(),
}))

vi.mock('@/services/conversation-links', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/conversation-links')>()
  return {
    ...actual,
    listLinkedTickets: (...args: unknown[]) => mockListLinked(...args),
    linkTicketToConversation: (...args: unknown[]) => mockLink(...args),
  }
})

const { GET, POST } = await import('./route')

beforeEach(() => {
  mockRequireRole.mockReset()
  mockListLinked.mockReset()
  mockLink.mockReset()
})

function okAuth(id = 'u-1') {
  mockRequireRole.mockResolvedValue({
    user: {
      id,
      email: `${id}@x`,
      role: 'soporte',
      display_name: 'X',
      suspended_at: null,
      deleted_at: null,
    },
  })
}

const TICKET_UUID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479'
const CONV_UUID = 'a5f7e6b8-12c3-4abc-89ef-0123456789ab'

const ctx = (id: string) => ({ params: Promise.resolve({ id }) })

function postReq(body: unknown) {
  return new Request(`http://x/api/conversations/${CONV_UUID}/tickets`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })
}

describe('GET /api/conversations/[id]/tickets', () => {
  it('returns 401 when unauthorized', async () => {
    const { NextResponse } = require('next/server') as typeof import('next/server')
    mockRequireRole.mockResolvedValue({
      error: NextResponse.json({ code: 'unauthorized' }, { status: 401 }),
    })
    const res = await GET(new Request('http://x'), ctx(CONV_UUID))
    expect(res.status).toBe(401)
    expect(mockListLinked).not.toHaveBeenCalled()
  })

  it('returns linked tickets list with 200', async () => {
    okAuth()
    mockListLinked.mockResolvedValue([{ id: 't-1', name: 'Login roto', status: 'open' }])
    const res = await GET(new Request('http://x'), ctx(CONV_UUID))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: Array<{ id: string }> }
    expect(body.data[0]!.id).toBe('t-1')
    expect(mockListLinked).toHaveBeenCalledWith(CONV_UUID)
  })

  it('returns 500 db_error when service throws', async () => {
    okAuth()
    mockListLinked.mockRejectedValue(new Error('db down'))
    const res = await GET(new Request('http://x'), ctx(CONV_UUID))
    expect(res.status).toBe(500)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe('db_error')
  })
})

describe('POST /api/conversations/[id]/tickets — Zod', () => {
  beforeEach(() => okAuth())

  it('returns 400 validation_failed when ticket_id is not a UUID', async () => {
    const res = await POST(postReq({ ticket_id: 'not-a-uuid' }), ctx(CONV_UUID))
    expect(res.status).toBe(400)
  })

  it('returns 400 invalid_json when body is not parseable', async () => {
    const req = new Request(`http://x/api/conversations/${CONV_UUID}/tickets`, {
      method: 'POST',
      body: '{not json',
    })
    const res = await POST(req, ctx(CONV_UUID))
    expect(res.status).toBe(400)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe('invalid_json')
  })
})

describe('POST /api/conversations/[id]/tickets — auth + service', () => {
  it('returns 401 when unauthorized', async () => {
    const { NextResponse } = require('next/server') as typeof import('next/server')
    mockRequireRole.mockResolvedValue({
      error: NextResponse.json({ code: 'unauthorized' }, { status: 401 }),
    })
    const res = await POST(postReq({ ticket_id: TICKET_UUID }), ctx(CONV_UUID))
    expect(res.status).toBe(401)
    expect(mockLink).not.toHaveBeenCalled()
  })

  it('returns 201 with the link on success', async () => {
    okAuth('u-actor')
    mockLink.mockResolvedValue({
      conversation_id: CONV_UUID,
      ticket_id: TICKET_UUID,
      linked_by: 'u-actor',
      linked_at: '2026-01-01',
    })
    const res = await POST(postReq({ ticket_id: TICKET_UUID }), ctx(CONV_UUID))
    expect(res.status).toBe(201)
    const body = (await res.json()) as { data: { ticket_id: string } }
    expect(body.data.ticket_id).toBe(TICKET_UUID)
    expect(mockLink).toHaveBeenCalledWith(CONV_UUID, TICKET_UUID, 'u-actor')
  })

  it('maps LinkError 404 ticket_not_found', async () => {
    okAuth()
    const { LinkError } = await import('@/services/conversation-links')
    mockLink.mockRejectedValue(new LinkError('ticket_not_found', 'Ticket no encontrado', 404))
    const res = await POST(postReq({ ticket_id: TICKET_UUID }), ctx(CONV_UUID))
    expect(res.status).toBe(404)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe('ticket_not_found')
  })

  it('maps LinkError 404 conversation_not_found', async () => {
    okAuth()
    const { LinkError } = await import('@/services/conversation-links')
    mockLink.mockRejectedValue(new LinkError('conversation_not_found', 'Conversación no encontrada', 404))
    const res = await POST(postReq({ ticket_id: TICKET_UUID }), ctx(CONV_UUID))
    expect(res.status).toBe(404)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe('conversation_not_found')
  })

  it('returns 500 db_error for non-LinkError exceptions', async () => {
    okAuth()
    mockLink.mockRejectedValue(new Error('connect ECONNREFUSED'))
    const res = await POST(postReq({ ticket_id: TICKET_UUID }), ctx(CONV_UUID))
    expect(res.status).toBe(500)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe('db_error')
  })
})

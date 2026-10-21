import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockRequireRole = vi.fn()
const mockUnlink = vi.fn()

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
    unlinkTicketFromConversation: (...args: unknown[]) => mockUnlink(...args),
  }
})

const { DELETE } = await import('./route')

beforeEach(() => {
  mockRequireRole.mockReset()
  mockUnlink.mockReset()
})

function okAuth() {
  mockRequireRole.mockResolvedValue({
    user: {
      id: 'u-1',
      email: 'u@x',
      role: 'soporte',
      display_name: 'X',
      suspended_at: null,
      deleted_at: null,
    },
  })
}

const TICKET_UUID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479'
const CONV_UUID = 'a5f7e6b8-12c3-4abc-89ef-0123456789ab'
const ctx = { params: Promise.resolve({ id: CONV_UUID, ticketId: TICKET_UUID }) }

describe('DELETE /api/conversations/[id]/tickets/[ticketId] — auth', () => {
  it('returns 401 when unauthorized', async () => {
    const { NextResponse } = require('next/server') as typeof import('next/server')
    mockRequireRole.mockResolvedValue({
      error: NextResponse.json({ code: 'unauthorized' }, { status: 401 }),
    })
    const res = await DELETE(new Request('http://x', { method: 'DELETE' }), ctx)
    expect(res.status).toBe(401)
    expect(mockUnlink).not.toHaveBeenCalled()
  })
})

describe('DELETE /api/conversations/[id]/tickets/[ticketId] — happy + error', () => {
  it('returns the service result on success (removed: true)', async () => {
    okAuth()
    mockUnlink.mockResolvedValue({ removed: true })
    const res = await DELETE(new Request('http://x', { method: 'DELETE' }), ctx)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { removed: boolean } }
    expect(body.data.removed).toBe(true)
    expect(mockUnlink).toHaveBeenCalledWith(CONV_UUID, TICKET_UUID)
  })

  it('returns 200 with removed: false when nothing was linked', async () => {
    okAuth()
    mockUnlink.mockResolvedValue({ removed: false })
    const res = await DELETE(new Request('http://x', { method: 'DELETE' }), ctx)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { removed: boolean } }
    expect(body.data.removed).toBe(false)
  })

  it('returns 500 db_error when service throws', async () => {
    okAuth()
    mockUnlink.mockRejectedValue(new Error('db down'))
    const res = await DELETE(new Request('http://x', { method: 'DELETE' }), ctx)
    expect(res.status).toBe(500)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe('db_error')
  })
})

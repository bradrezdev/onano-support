import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockRequireRole = vi.fn()
const mockCreateTicket = vi.fn()

vi.mock('@/lib/auth', () => ({
  requireUser: vi.fn(),
    requirePermission: (...args: unknown[]) => mockRequireRole(...args),
  requireAllPermissions: (...args: unknown[]) => mockRequireRole(...args),requireRole: (...args: unknown[]) => mockRequireRole(...args),
  getCurrentUser: vi.fn(),
}))

vi.mock('@/services/tickets', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/tickets')>()
  return {
    ...actual,
    createTicket: (...args: unknown[]) => mockCreateTicket(...args),
  }
})

const { POST } = await import('./route')

beforeEach(() => {
  mockRequireRole.mockReset()
  mockCreateTicket.mockReset()
})

function okAuth(role: 'admin' | 'supervisor' | 'soporte' = 'soporte', id = 'u-1') {
  mockRequireRole.mockResolvedValue({
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
  mockRequireRole.mockResolvedValue({
    error: NextResponse.json({ code, error: code, message }, { status }),
  })
}

function postReq(body: unknown) {
  return new Request('http://x/api/tickets', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })
}

const valid = {
  contact_id: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
  category_id: 'a5f7e6b8-12c3-4abc-89ef-0123456789ab',
  name: 'Login roto',
  description: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'desc' }] }] },
}

describe('POST /api/tickets — auth', () => {
  it('returns 401 when unauthorized', async () => {
    denyAuth(401, 'unauthorized', 'Not signed in')
    const res = await POST(postReq(valid))
    expect(res.status).toBe(401)
    expect(mockCreateTicket).not.toHaveBeenCalled()
  })

  it('allows admin, supervisor, soporte', async () => {
    for (const role of ['admin', 'supervisor', 'soporte'] as const) {
      mockRequireRole.mockReset()
      mockCreateTicket.mockReset()
      okAuth(role)
      mockCreateTicket.mockResolvedValue({ id: 'tk-1' })
      const res = await POST(postReq(valid))
      expect(res.status).toBe(201)
    }
  })
})

describe('POST /api/tickets — Zod', () => {
  beforeEach(() => okAuth())

  it('returns 400 invalid_json when body is not JSON', async () => {
    const req = new Request('http://x/api/tickets', { method: 'POST', body: '{not json' })
    const res = await POST(req)
    expect(res.status).toBe(400)
  })

  it('returns 400 validation_failed when contact_id is not a UUID', async () => {
    const res = await POST(postReq({ ...valid, contact_id: 'not-a-uuid' }))
    expect(res.status).toBe(400)
    const body = (await res.json()) as { code: string; details: Array<{ path: string }> }
    expect(body.code).toBe('validation_failed')
    expect(body.details[0]!.path).toBe('contact_id')
  })

  it('returns 400 validation_failed when name is empty', async () => {
    const res = await POST(postReq({ ...valid, name: '' }))
    expect(res.status).toBe(400)
  })

  it('returns 400 validation_failed when name exceeds 200 chars', async () => {
    const res = await POST(postReq({ ...valid, name: 'x'.repeat(201) }))
    expect(res.status).toBe(400)
  })

  it('returns 400 validation_failed when description is missing', async () => {
    const { description, ...rest } = valid
    void description
    const res = await POST(postReq(rest))
    expect(res.status).toBe(400)
    const body = (await res.json()) as { details: Array<{ path: string }> }
    expect(body.details[0]!.path).toBe('description')
  })
})

describe('POST /api/tickets — happy path', () => {
  it('returns 201 with the created ticket', async () => {
    okAuth('admin', 'u-admin')
    mockCreateTicket.mockResolvedValue({ id: 'tk-1', name: 'Login roto' })
    const res = await POST(postReq(valid))
    expect(res.status).toBe(201)
    const body = (await res.json()) as { data: { id: string } }
    expect(body.data.id).toBe('tk-1')
    expect(mockCreateTicket).toHaveBeenCalledWith(valid, 'u-admin')
  })

  it('accepts null assigned_to / theme_id / flow_id', async () => {
    okAuth()
    mockCreateTicket.mockResolvedValue({ id: 'tk-1' })
    const res = await POST(postReq({
      ...valid,
      assigned_to: null,
      theme_id: null,
      flow_id: null,
    }))
    expect(res.status).toBe(201)
  })
})

describe('POST /api/tickets — error mapping', () => {
  beforeEach(() => okAuth())

  it('maps TicketValidationError to its status', async () => {
    const { TicketValidationError } = await import('@/services/tickets')
    mockCreateTicket.mockRejectedValue(new TicketValidationError('invalid_description', 'desc must be a TipTap doc'))
    const res = await POST(postReq(valid))
    expect(res.status).toBe(400)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe('invalid_description')
  })

  it('maps Postgres FK violation (23503) to 400 invalid_fk', async () => {
    mockCreateTicket.mockRejectedValue({ code: '23503', message: 'fk' })
    const res = await POST(postReq(valid))
    expect(res.status).toBe(400)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe('invalid_fk')
  })

  it('maps any other Error to 500 db_error', async () => {
    mockCreateTicket.mockRejectedValue(new Error('connect ECONNREFUSED'))
    const res = await POST(postReq(valid))
    expect(res.status).toBe(500)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe('db_error')
  })
})

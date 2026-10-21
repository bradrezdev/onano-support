import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockRequireRole = vi.fn()
const mockListColors = vi.fn()
const mockUpsertColor = vi.fn()

vi.mock('@/lib/auth', () => ({
  requireUser: vi.fn(),
    requirePermission: (...args: unknown[]) => mockRequireRole(...args),
  requireAllPermissions: (...args: unknown[]) => mockRequireRole(...args),requireRole: (...args: unknown[]) => mockRequireRole(...args),
  getCurrentUser: vi.fn(),
}))

vi.mock('@/services/ticket-messages', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/ticket-messages')>()
  return {
    ...actual,
    listRoleColors: (...args: unknown[]) => mockListColors(...args),
    upsertRoleColor: (...args: unknown[]) => mockUpsertColor(...args),
  }
})

const { GET, PUT } = await import('./route')

beforeEach(() => {
  mockRequireRole.mockReset()
  mockListColors.mockReset()
  mockUpsertColor.mockReset()
})

function okAuth(role: 'admin' | 'supervisor' | 'soporte' = 'admin', id = 'u-1') {
  mockRequireRole.mockResolvedValue({
    user: {
      id, email: `${id}@x`, role,
      display_name: 'X', suspended_at: null, deleted_at: null,
    },
  })
}

function denyAuth(status: number, code: string, message: string) {
  const { NextResponse } = require('next/server') as typeof import('next/server')
  mockRequireRole.mockResolvedValue({
    error: NextResponse.json({ code, error: code, message }, { status }),
  })
}

const PUT_URL = 'http://x/api/role-colors'

function putReq(body: unknown) {
  return new Request(PUT_URL, {
    method: 'PUT',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })
}

describe('GET /api/role-colors', () => {
  it('returns 401 when unauthorized', async () => {
    denyAuth(401, 'unauthorized', 'Not signed in')
    const res = await GET(new Request('http://x/api/role-colors'))
    expect(res.status).toBe(401)
  })

  it('allows any logged-in role', async () => {
    for (const role of ['admin', 'supervisor', 'soporte'] as const) {
      mockRequireRole.mockReset()
      mockListColors.mockReset()
      okAuth(role)
      mockListColors.mockResolvedValue([])
      const res = await GET(new Request('http://x/api/role-colors'))
      expect(res.status).toBe(200)
    }
  })

  it('returns 500 db_error when service throws', async () => {
    okAuth()
    mockListColors.mockRejectedValue(new Error('db down'))
    const res = await GET(new Request('http://x/api/role-colors'))
    expect(res.status).toBe(500)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe('db_error')
  })
})

describe('PUT /api/role-colors — auth', () => {
  it('returns 401 when unauthorized', async () => {
    denyAuth(401, 'unauthorized', 'Not signed in')
    const res = await PUT(putReq({ role: 'admin', base_color: '#ff00ff', fade_steps: 8 }))
    expect(res.status).toBe(401)
  })

  it('returns 403 when role is not admin', async () => {
    denyAuth(403, 'forbidden', 'Requires role: admin')
    const res = await PUT(putReq({ role: 'admin', base_color: '#ff00ff', fade_steps: 8 }))
    expect(res.status).toBe(403)
  })
})

describe('PUT /api/role-colors — Zod', () => {
  beforeEach(() => okAuthAdmin())

  it('returns 400 when base_color is not #RRGGBB', async () => {
    const res = await PUT(putReq({ role: 'admin', base_color: 'red', fade_steps: 5 }))
    expect(res.status).toBe(400)
    const body = (await res.json()) as { details: Array<{ path: string }> }
    expect(body.details[0]!.path).toBe('base_color')
  })

  it('returns 400 when fade_steps < 1', async () => {
    const res = await PUT(putReq({ role: 'admin', base_color: '#ff00ff', fade_steps: 0 }))
    expect(res.status).toBe(400)
  })

  it('returns 400 when fade_steps > 10', async () => {
    const res = await PUT(putReq({ role: 'admin', base_color: '#ff00ff', fade_steps: 11 }))
    expect(res.status).toBe(400)
  })

  it('returns 400 when fade_steps is not an integer', async () => {
    const res = await PUT(putReq({ role: 'admin', base_color: '#ff00ff', fade_steps: 1.5 }))
    expect(res.status).toBe(400)
  })

  it('returns 400 when role is not in enum', async () => {
    const res = await PUT(putReq({ role: 'god', base_color: '#ff00ff', fade_steps: 5 }))
    expect(res.status).toBe(400)
  })
})

describe('PUT /api/role-colors — happy + error', () => {
  beforeEach(() => okAuthAdmin())

  it('returns the upserted setting on success', async () => {
    mockUpsertColor.mockResolvedValue({ role: 'admin', base_color: '#abcdef', fade_steps: 8 })
    const res = await PUT(putReq({ role: 'admin', base_color: '#ABCDEF', fade_steps: 8 }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { role: string; fade_steps: number } }
    expect(body.data.role).toBe('admin')
    expect(body.data.fade_steps).toBe(8)
    expect(mockUpsertColor).toHaveBeenCalledWith('admin', '#ABCDEF', 8, 'u-1')
  })

  it('maps TicketMessageError 400 to its declared code', async () => {
    const { TicketMessageError } = await import('@/services/ticket-messages')
    mockUpsertColor.mockRejectedValue(new TicketMessageError('invalid_color', 'Color debe ser #RRGGBB', 400))
    const res = await PUT(putReq({ role: 'admin', base_color: '#ff00ff', fade_steps: 8 }))
    expect(res.status).toBe(400)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe('invalid_color')
  })

  it('maps other errors to 500 db_error', async () => {
    mockUpsertColor.mockRejectedValue(new Error('db down'))
    const res = await PUT(putReq({ role: 'admin', base_color: '#ff00ff', fade_steps: 8 }))
    expect(res.status).toBe(500)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe('db_error')
  })
})

function okAuthAdmin() { okAuth('admin') }

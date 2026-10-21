import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockRequireRole = vi.fn()
const mockListThemes = vi.fn()
const mockCreateTheme = vi.fn()

vi.mock('@/lib/auth', () => ({
  requireUser: vi.fn(),
    requirePermission: (...args: unknown[]) => mockRequireRole(...args),
  requireAllPermissions: (...args: unknown[]) => mockRequireRole(...args),requireRole: (...args: unknown[]) => mockRequireRole(...args),
  getCurrentUser: vi.fn(),
}))

vi.mock('@/services/themes', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/themes')>()
  return {
    ...actual,
    listThemesWithFlows: (...args: unknown[]) => mockListThemes(...args),
    createTheme: (...args: unknown[]) => mockCreateTheme(...args),
  }
})

const { GET, POST } = await import('./route')

beforeEach(() => {
  mockRequireRole.mockReset()
  mockListThemes.mockReset()
  mockCreateTheme.mockReset()
})

function okAuthAdmin() {
  mockRequireRole.mockResolvedValue({
    user: {
      id: 'u-admin', email: 'a@x', role: 'admin',
      display_name: 'Admin', suspended_at: null, deleted_at: null,
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
  return new Request('http://x/api/themes', {
    method: 'POST', body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })
}

describe('POST /api/themes — auth', () => {
  it('returns 401 when unauthorized', async () => {
    denyAuth(401, 'unauthorized', 'Not signed in')
    const res = await POST(postReq({ name: 'Onboarding' }))
    expect(res.status).toBe(401)
    expect(mockCreateTheme).not.toHaveBeenCalled()
  })

  it('returns 403 when role is not admin', async () => {
    denyAuth(403, 'forbidden', 'Requires role: admin')
    const res = await POST(postReq({ name: 'Onboarding' }))
    expect(res.status).toBe(403)
  })
})

describe('POST /api/themes — Zod', () => {
  beforeEach(() => okAuthAdmin())

  it('returns 400 validation_failed when name is missing', async () => {
    const res = await POST(postReq({}))
    expect(res.status).toBe(400)
  })

  it('returns 400 validation_failed when color is malformed hex', async () => {
    const res = await POST(postReq({ name: 'Onboarding', color: 'red' }))
    expect(res.status).toBe(400)
    const body = (await res.json()) as { details: Array<{ path: string }> }
    expect(body.details[0]!.path).toBe('color')
  })

  it('accepts color in #RRGGBB form', async () => {
    mockCreateTheme.mockResolvedValue({ id: 't-1', name: 'Onboarding', color: '#ff00ff' })
    const res = await POST(postReq({ name: 'Onboarding', color: '#ff00ff' }))
    expect(res.status).toBe(201)
    expect(mockCreateTheme).toHaveBeenCalledWith(
      { name: 'Onboarding', description: undefined, color: '#ff00ff' },
      'u-admin',
    )
  })
})

describe('POST /api/themes — happy path + error mapping', () => {
  beforeEach(() => okAuthAdmin())

  it('returns 201 with the created theme on success', async () => {
    mockCreateTheme.mockResolvedValue({ id: 't-1', name: 'Onboarding', position: 0 })
    const res = await POST(postReq({ name: 'Onboarding' }))
    expect(res.status).toBe(201)
    const body = (await res.json()) as { data: { id: string } }
    expect(body.data.id).toBe('t-1')
  })

  it('maps ThemeError 409 duplicate to 409', async () => {
    const { ThemeError } = await import('@/services/themes')
    mockCreateTheme.mockRejectedValue(new ThemeError(409, 'duplicate', 'Theme "Onboarding" already exists'))
    const res = await POST(postReq({ name: 'Onboarding' }))
    expect(res.status).toBe(409)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe('duplicate')
  })

  it('maps other errors to 500 db_error', async () => {
    mockCreateTheme.mockRejectedValue(new Error('db down'))
    const res = await POST(postReq({ name: 'Onboarding' }))
    expect(res.status).toBe(500)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe('db_error')
  })
})

describe('GET /api/themes', () => {
  it('returns 200 with themes list', async () => {
    mockRequireRole.mockResolvedValue({
      user: { id: 'u', email: 'u@x', role: 'soporte', display_name: 'U', suspended_at: null, deleted_at: null },
    })
    mockListThemes.mockResolvedValue([{ id: 't-1', name: 'Onboarding', flows: [] }])
    const res = await GET(new Request('http://x/api/themes'))
    expect(res.status).toBe(200)
  })
})

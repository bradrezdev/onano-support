import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

const mockRequireUser = vi.fn()
const mockUpdateOwnProfile = vi.fn()

vi.mock('@/lib/auth', () => ({
  requireUser: (...args: unknown[]) => mockRequireUser(...args),
  requirePermission: vi.fn(),
  requireAllPermissions: vi.fn(),
  requireRole: vi.fn(),
  getCurrentUser: vi.fn(),
}))

vi.mock('@/services/users', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/users')>()
  return {
    ...actual,
    updateOwnProfile: (...args: unknown[]) => mockUpdateOwnProfile(...args),
  }
})

const { GET, PATCH } = await import('./route')

beforeEach(() => {
  mockRequireUser.mockReset()
  mockUpdateOwnProfile.mockReset()
})

function okAuth() {
  mockRequireUser.mockResolvedValue({
    user: {
      id: 'u-1',
      email: 'u@x.com',
      role: 'admin',
      role_key: 'admin',
      permissions: ['admin.viewAudit'],
      display_name: 'Ana',
      phone: null,
      suspended_at: null,
      deleted_at: null,
    },
  })
}

const URL = 'http://x/api/me'

function patchReq(body: unknown) {
  return new Request(URL, {
    method: 'PATCH',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })
}

describe('PATCH /api/me', () => {
  it('needs a session, not a permission key', async () => {
    // Every account owns exactly one row; there is no key to hold.
    okAuth()
    mockUpdateOwnProfile.mockResolvedValue({ id: 'u-1', display_name: 'Ana', phone: null })
    await PATCH(patchReq({ display_name: 'Ana' }))
    expect(mockRequireUser).toHaveBeenCalled()
  })

  it('returns 401 without a session', async () => {
    mockRequireUser.mockResolvedValue({
      error: NextResponse.json(
        { code: 'unauthorized', error: 'unauthorized', message: 'Not signed in' },
        { status: 401 },
      ),
    })
    const res = await PATCH(patchReq({ display_name: 'Ana' }))
    expect(res.status).toBe(401)
    expect(mockUpdateOwnProfile).not.toHaveBeenCalled()
  })

  it('accepts the two allowed fields', async () => {
    okAuth()
    mockUpdateOwnProfile.mockResolvedValue({
      id: 'u-1',
      display_name: 'Ana Nueva',
      phone: '+52 555 0001111',
    })
    const res = await PATCH(
      patchReq({ display_name: 'Ana Nueva', phone: '+52 555 0001111' }),
    )
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({
      data: { display_name: 'Ana Nueva', phone: '+52 555 0001111' },
    })
  })

  it.each(['role', 'role_key', 'suspended_at', 'permissions', 'id'])(
    'rejects %s instead of silently dropping it',
    async (field) => {
      // Zod's default `object` strips unknown keys: the request would succeed
      // with nothing written, and the caller would read that as "saved". The
      // schema is strict so the answer is honest.
      okAuth()
      const res = await PATCH(patchReq({ [field]: 'x' }))
      expect(res.status).toBe(400)
      expect(mockUpdateOwnProfile).not.toHaveBeenCalled()
    },
  )

  it('rejects a display_name past the column limit', async () => {
    okAuth()
    const res = await PATCH(patchReq({ display_name: 'x'.repeat(121) }))
    expect(res.status).toBe(400)
    expect(mockUpdateOwnProfile).not.toHaveBeenCalled()
  })

  it('turns a service failure into a 500', async () => {
    okAuth()
    mockUpdateOwnProfile.mockRejectedValue(new Error('deadlock detected'))
    const res = await PATCH(patchReq({ display_name: 'Ana' }))
    expect(res.status).toBe(500)
  })
})

describe('GET /api/me', () => {
  it('returns the profile with phone and the permission catalogue', async () => {
    okAuth()
    const res = await GET(new Request(URL))
    const body = (await res.json()) as {
      data: Record<string, unknown>
      catalog: unknown
    }
    expect(body.data).toMatchObject({
      id: 'u-1',
      email: 'u@x.com',
      display_name: 'Ana',
      phone: null,
      permissions: ['admin.viewAudit'],
    })
    expect(Array.isArray(body.catalog)).toBe(true)
  })
})
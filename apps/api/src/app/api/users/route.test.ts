import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

const mockRequirePermission = vi.fn()
const mockCreateUser = vi.fn()
const mockListUsers = vi.fn()
const mockSearchUsers = vi.fn()

vi.mock('@/lib/auth', () => ({
  requireUser: vi.fn(),
  requirePermission: (...args: unknown[]) => mockRequirePermission(...args),
  requireAllPermissions: (...args: unknown[]) => mockRequirePermission(...args),
  requireRole: (...args: unknown[]) => mockRequirePermission(...args),
  getCurrentUser: vi.fn(),
}))

vi.mock('@/services/users', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/users')>()
  return {
    ...actual,
    createUser: (...args: unknown[]) => mockCreateUser(...args),
    listUsers: (...args: unknown[]) => mockListUsers(...args),
    searchUsers: (...args: unknown[]) => mockSearchUsers(...args),
  }
})

const { GET, POST } = await import('./route')

beforeEach(() => {
  mockRequirePermission.mockReset()
  mockCreateUser.mockReset()
  mockListUsers.mockReset()
  mockSearchUsers.mockReset()
})

function okAuth(id = 'admin-1') {
  mockRequirePermission.mockResolvedValue({
    user: {
      id,
      email: `${id}@x`,
      role: 'admin',
      role_key: 'admin',
      permissions: ['admin.createUser', 'admin.viewAccounts'],
      display_name: 'A',
      phone: null,
      suspended_at: null,
      deleted_at: null,
    },
  })
}

function denyAuth(status: number, code: string, message: string) {
  mockRequirePermission.mockResolvedValue({
    error: NextResponse.json({ code, error: code, message }, { status }),
  })
}

const URL = 'http://x/api/users'

function postReq(body: unknown) {
  return new Request(URL, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })
}

const VALID = {
  email: 'nuevo@x.com',
  password: 'abcd1234',
  display_name: 'Nuevo',
  role_key: 'soporte',
}

describe('POST /api/users', () => {
  it('requires admin.createUser', async () => {
    okAuth()
    await POST(postReq(VALID))
    expect(mockRequirePermission).toHaveBeenCalledWith(['admin.createUser'], expect.anything())
  })

  it('returns 403 when the key is not held', async () => {
    denyAuth(403, 'forbidden', 'Requires permission: admin.createUser')
    const res = await POST(postReq(VALID))
    expect(res.status).toBe(403)
    expect(mockCreateUser).not.toHaveBeenCalled()
  })

  it('returns 401 when not signed in', async () => {
    denyAuth(401, 'unauthorized', 'Not signed in')
    const res = await POST(postReq(VALID))
    expect(res.status).toBe(401)
  })

  it('rejects a password shorter than 8 characters before calling the service', async () => {
    okAuth()
    const res = await POST(postReq({ ...VALID, password: 'short' }))
    expect(res.status).toBe(400)
    expect(mockCreateUser).not.toHaveBeenCalled()
  })

  it('rejects a malformed email', async () => {
    okAuth()
    const res = await POST(postReq({ ...VALID, email: 'not-an-email' }))
    expect(res.status).toBe(400)
    expect(mockCreateUser).not.toHaveBeenCalled()
  })

  it('creates with 201 and returns the account', async () => {
    okAuth()
    mockCreateUser.mockResolvedValue({ id: 'new-1', email: VALID.email })
    const res = await POST(postReq(VALID))
    expect(res.status).toBe(201)
    await expect(res.json()).resolves.toMatchObject({
      data: { id: 'new-1' },
    })
    // The actor id must reach the service so profiles.created_by is written.
    expect(mockCreateUser).toHaveBeenCalledWith(
      expect.objectContaining({ email: VALID.email }),
      'admin-1',
    )
  })

  it('maps a duplicate email to 409', async () => {
    okAuth()
    const { UserValidationError } = await import('@/services/users')
    mockCreateUser.mockRejectedValue(
      new UserValidationError('email_taken', 'Ya existe una cuenta con ese email'),
    )
    const res = await POST(postReq(VALID))
    expect(res.status).toBe(409)
  })

  it('surfaces other validation errors with their own status', async () => {
    okAuth()
    const { UserValidationError } = await import('@/services/users')
    mockCreateUser.mockRejectedValue(
      new UserValidationError('role_not_found', 'El rol "x" no existe'),
    )
    const res = await POST(postReq(VALID))
    expect(res.status).toBe(400)
  })

  it('turns an unexpected throw into a 500 instead of leaking it', async () => {
    okAuth()
    mockCreateUser.mockRejectedValue(new Error('socket hang up'))
    const res = await POST(postReq(VALID))
    expect(res.status).toBe(500)
  })
})

describe('GET /api/users', () => {
  it('requires admin.viewAccounts', async () => {
    okAuth()
    await GET(new Request(URL))
    expect(mockRequirePermission).toHaveBeenCalledWith(
      ['admin.viewAccounts'],
      expect.anything(),
    )
  })

  it('searches when q is present and lists otherwise', async () => {
    okAuth()
    mockSearchUsers.mockResolvedValue([{ id: 'a' }])
    const res = await GET(new Request(`${URL}?q=ali`))
    expect(res.status).toBe(200)
    expect(mockSearchUsers).toHaveBeenCalledWith('ali')
    expect(mockListUsers).not.toHaveBeenCalled()
  })

  it('lists every account with no query', async () => {
    okAuth()
    mockListUsers.mockResolvedValue([{ id: 'a' }, { id: 'b' }])
    const res = await GET(new Request(URL))
    await expect(res.json()).resolves.toMatchObject({
      data: [{ id: 'a' }, { id: 'b' }],
    })
  })
})
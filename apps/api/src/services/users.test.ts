import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { UserWithProfile } from './users'

// ---------------------------------------------------------------------------
// Supabase query mock. Reused across service tests.
// ---------------------------------------------------------------------------

type Response = { data: unknown; error?: unknown }
type Op = { op: string; args: unknown[] }

class QueryMock {
  ops: Op[] = []
  payload: Response = { data: null, error: null }

  private record(op: string, args: unknown[]): this {
    this.ops.push({ op, args })
    return this
  }
  select(...args: unknown[]) { return this.record('select', args) }
  eq(col: string, val: unknown) { return this.record('eq', [col, val]) }
  order(col: string, opts?: unknown) { return this.record('order', [col, opts]) }
  update(rows: unknown) { return this.record('update', [rows]) }
  insert(rows: unknown) { return this.record('insert', [rows]) }
  maybeSingle(): Promise<Response> { return Promise.resolve(this.payload) }
  single(): Promise<Response> {
    const d = Array.isArray(this.payload.data) ? this.payload.data[0] : this.payload.data
    return Promise.resolve({ ...this.payload, data: d })
  }
  then<T>(onFulfilled: (v: Response) => T): Promise<T> {
    return Promise.resolve(this.payload).then(onFulfilled)
  }
}

const mockAdmin: any = {
  from: vi.fn((): QueryMock => new QueryMock()),
  auth: {
    admin: {
      listUsers: vi.fn(),
      getUserById: vi.fn(),
    },
  },
}

vi.mock('@/lib/supabase/admin', () => ({
  createSupabaseAdminClient: () => mockAdmin,
}))

const users = await import('./users')

beforeEach(() => {
  mockAdmin.from.mockReset()
  mockAdmin.auth.admin.listUsers.mockReset()
  mockAdmin.auth.admin.getUserById.mockReset()
})

function makeProfile(overrides: Partial<UserWithProfile> = {}): UserWithProfile {
  return {
    id: 'u-1',
    email: 'a@b.com',
    display_name: 'Alice',
    role: 'admin',
    avatar_url: null,
    suspended_at: null,
    deleted_at: null,
    created_at: '2026-01-01T00:00:00Z',
    last_sign_in_at: null,
    ...overrides,
  }
}

// findUserOrThrow uses Promise.all over profiles + admin.auth.admin.getUserById.
// We mock both with a profile from `profiles` and an auth user from auth.
function setUpFindUser(profile: UserWithProfile | null) {
  const profileQ = new QueryMock()
  profileQ.payload = { data: profile, error: null }
  mockAdmin.from.mockReturnValueOnce(profileQ)
  mockAdmin.auth.admin.getUserById.mockResolvedValueOnce({
    data: {
      user: {
        id: profile?.id ?? 'u-1',
        email: profile?.email ?? 'a@b.com',
        created_at: profile?.created_at ?? '2026-01-01T00:00:00Z',
        last_sign_in_at: profile?.last_sign_in_at ?? null,
      },
    },
    error: null,
  })
}

// ---------------------------------------------------------------------------
// updateUser — guards
// ---------------------------------------------------------------------------

describe('updateUser — self-action guards', () => {
  it('refuses to suspend yourself (would lock the workspace)', async () => {
    await expect(
      users.updateUser('u-1', { suspend: true }, 'u-1'),
    ).rejects.toMatchObject({ code: 'self_suspend' })
    expect(mockAdmin.from).not.toHaveBeenCalled()
    expect(mockAdmin.auth.admin.getUserById).not.toHaveBeenCalled()
  })

  it('refuses to demote yourself to a non-admin role', async () => {
    for (const role of ['supervisor', 'soporte'] as const) {
      await expect(
        users.updateUser('u-1', { role }, 'u-1'),
      ).rejects.toMatchObject({ code: 'self_demote' })
    }
    expect(mockAdmin.from).not.toHaveBeenCalled()
  })

  it('locks every self-role-change that lands on a non-admin role (anti-lockout by design)', async () => {
    // Even a self-promotion from soporte → supervisor is blocked: any self
    // role change away from admin could be used to lock the workspace.
    const before = makeProfile({ id: 'u-1', role: 'soporte' })
    setUpFindUser(before)
    await expect(
      users.updateUser('u-1', { role: 'supervisor' }, 'u-1'),
    ).rejects.toMatchObject({ code: 'self_demote' })
    expect(mockAdmin.from).not.toHaveBeenCalled()
  })
})

describe('updateUser — deleted-user guard', () => {
  it('refuses to mutate a deleted user', async () => {
    const before = makeProfile({ id: 'u-2', deleted_at: '2026-02-01T00:00:00Z' })
    setUpFindUser(before)
    await expect(
      users.updateUser('u-2', { role: 'soporte' }, 'u-1'),
    ).rejects.toMatchObject({ code: 'user_deleted' })
    expect(mockAdmin.from).not.toHaveBeenCalledWith()
  })
})

// ---------------------------------------------------------------------------
// updateUser — happy path / no-op / mutations
// ---------------------------------------------------------------------------

describe('updateUser — mutations', () => {
  it('changes role when patch differs from current', async () => {
    const before = makeProfile({ id: 'u-2', role: 'soporte' })
    setUpFindUser(before)
    const updateQ = new QueryMock()
    updateQ.payload = { data: null, error: null }
    mockAdmin.from.mockReturnValueOnce(updateQ)

    const out = await users.updateUser('u-2', { role: 'supervisor' }, 'u-1')
    expect(out.role).toBe('supervisor')
    const updateOp = updateQ.ops.find((o) => o.op === 'update')
    expect(updateOp!.args[0]).toEqual({ role: 'supervisor' })
    const eqOp = updateQ.ops.find((o) => o.op === 'eq')
    expect(eqOp!.args).toEqual(['id', 'u-2'])
  })

  it('does not call update when role patch equals current role', async () => {
    const before = makeProfile({ id: 'u-2', role: 'admin' })
    setUpFindUser(before)
    // No update call expected; if it were, we would mockReturnValueOnce and fail.
    const out = await users.updateUser('u-2', { role: 'admin' }, 'u-1')
    expect(out.id).toBe('u-2')
  })

  it('suspends user when patch.suspend is true and user is currently active', async () => {
    const before = makeProfile({ id: 'u-2', suspended_at: null })
    setUpFindUser(before)
    const updateQ = new QueryMock()
    updateQ.payload = { data: null, error: null }
    mockAdmin.from.mockReturnValueOnce(updateQ)

    const out = await users.updateUser('u-2', { suspend: true }, 'u-1')
    expect(out.suspended_at).toBeTruthy()
    expect((out as unknown as Record<string, unknown>).suspended_by).toBe('u-1')
    const written = updateQ.ops.find((o) => o.op === 'update')!.args[0] as Record<string, unknown>
    expect(written.suspended_at).toBeTruthy()
    expect(written.suspended_by).toBe('u-1')
  })

  it('reactivates user when patch.suspend is false and user is currently suspended', async () => {
    const before = makeProfile({ id: 'u-2', suspended_at: '2026-01-15T00:00:00Z' })
    setUpFindUser(before)
    const updateQ = new QueryMock()
    updateQ.payload = { data: null, error: null }
    mockAdmin.from.mockReturnValueOnce(updateQ)

    const out = await users.updateUser('u-2', { suspend: false }, 'u-1')
    expect(out.suspended_at).toBeNull()
    const written = updateQ.ops.find((o) => o.op === 'update')!.args[0] as Record<string, unknown>
    expect(written.suspended_at).toBeNull()
    expect(written.suspended_by).toBeNull()
  })

  it('does not call update when suspension state already matches', async () => {
    const before = makeProfile({ id: 'u-2', suspended_at: null })
    setUpFindUser(before)
    const out = await users.updateUser('u-2', { suspend: false }, 'u-1')
    expect(out.id).toBe('u-2')
  })

  it('trims display_name on patch', async () => {
    const before = makeProfile({ id: 'u-2', display_name: 'Alice' })
    setUpFindUser(before)
    const updateQ = new QueryMock()
    updateQ.payload = { data: null, error: null }
    mockAdmin.from.mockReturnValueOnce(updateQ)

    const out = await users.updateUser('u-2', { display_name: '  Alice Cooper  ' }, 'u-1')
    expect(out.display_name).toBe('Alice Cooper')
    const written = updateQ.ops.find((o) => o.op === 'update')!.args[0] as Record<string, unknown>
    expect(written.display_name).toBe('Alice Cooper')
  })

  it('propagates Supabase errors from update', async () => {
    const before = makeProfile({ id: 'u-2', role: 'soporte' })
    setUpFindUser(before)
    const updateQ = new QueryMock()
    updateQ.payload = { data: null, error: { message: 'db down' } }
    mockAdmin.from.mockReturnValueOnce(updateQ)
    await expect(
      users.updateUser('u-2', { role: 'admin' }, 'u-1'),
    ).rejects.toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// searchUsers
// ---------------------------------------------------------------------------

describe('searchUsers', () => {
  it('returns [] for empty/whitespace query', async () => {
    expect(await users.searchUsers('')).toEqual([])
    expect(await users.searchUsers('   ')).toEqual([])
    expect(mockAdmin.auth.admin.listUsers).not.toHaveBeenCalled()
  })

  it('filters by email or display_name (case-insensitive)', async () => {
    // listUsers internally issues 2 parallel from() + admin.auth.admin.listUsers.
    // Mock both: profiles returns full list; auth returns user list.
    const profileRows = [
      { id: 'u-1', role: 'admin', display_name: 'Alice Cooper', avatar_url: null, suspended_at: null, deleted_at: null },
      { id: 'u-2', role: 'soporte', display_name: 'Bob Marley', avatar_url: null, suspended_at: null, deleted_at: null },
      { id: 'u-3', role: 'soporte', display_name: 'Alice Smith', avatar_url: null, suspended_at: null, deleted_at: '2026-02-01T00:00:00Z' },
    ]
    const profilesQ = new QueryMock()
    profilesQ.payload = { data: profileRows, error: null }
    mockAdmin.from.mockReturnValueOnce(profilesQ)
    mockAdmin.auth.admin.listUsers.mockResolvedValueOnce({
      data: {
        users: [
          { id: 'u-1', email: 'alice.c@example.com' },
          { id: 'u-2', email: 'bob@example.com' },
          { id: 'u-3', email: 'alice.s@example.com' },
        ],
      },
      error: null,
    })
    const out = await users.searchUsers('alice')
    expect(out.map((u) => u.id).sort()).toEqual(['u-1']) // u-3 is deleted, excluded
  })

  it('excludes deleted users from results', async () => {
    const profileRows = [
      { id: 'u-1', role: 'soporte', display_name: 'Deleted Alice', avatar_url: null, suspended_at: null, deleted_at: '2026-02-01T00:00:00Z' },
    ]
    const profilesQ = new QueryMock()
    profilesQ.payload = { data: profileRows, error: null }
    mockAdmin.from.mockReturnValueOnce(profilesQ)
    mockAdmin.auth.admin.listUsers.mockResolvedValueOnce({
      data: { users: [{ id: 'u-1', email: 'x@example.com' }] },
      error: null,
    })
    const out = await users.searchUsers('alice')
    expect(out).toEqual([])
  })
})

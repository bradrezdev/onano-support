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
  rpc: vi.fn(),
  auth: {
    admin: {
      listUsers: vi.fn(),
      getUserById: vi.fn(),
      createUser: vi.fn(),
      deleteUser: vi.fn(),
    },
  },
}

vi.mock('@/lib/supabase/admin', () => ({
  createSupabaseAdminClient: () => mockAdmin,
}))

const users = await import('./users')

beforeEach(() => {
  mockAdmin.from.mockReset()
  mockAdmin.rpc.mockReset()
  mockAdmin.rpc.mockResolvedValue({ data: null, error: null })
  mockAdmin.auth.admin.listUsers.mockReset()
  mockAdmin.auth.admin.getUserById.mockReset()
  mockAdmin.auth.admin.createUser.mockReset()
  mockAdmin.auth.admin.deleteUser.mockReset()
  mockAdmin.auth.admin.deleteUser.mockResolvedValue({ data: null, error: null })
})

function makeProfile(overrides: Partial<UserWithProfile> = {}): UserWithProfile {
  return {
    id: 'u-1',
    email: 'a@b.com',
    display_name: 'Alice',
    phone: null,
    role: 'admin',
    role_key: 'admin',
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
    const before = makeProfile({ id: 'u-2', role: 'soporte', role_key: 'soporte' })
    setUpFindUser(before)
    // The role lookup happens before the update (R2: the slug must exist).
    const roleQ = new QueryMock()
    roleQ.payload = { data: { key: 'supervisor', is_system: true }, error: null }
    mockAdmin.from.mockReturnValueOnce(roleQ)

    const out = await users.updateUser('u-2', { role: 'supervisor' }, 'u-1')
    expect(out.role_key).toBe('supervisor')
    // One transactional call carries the change AND writes its audit entry.
    expect(mockAdmin.rpc).toHaveBeenCalledWith('admin_update_profile', {
      p_profile_id: 'u-2',
      p_role_key: 'supervisor',
      p_suspend: null,
      p_display_name: null,
      p_actor: 'u-1',
    })
    // A shipped role mirrors into the legacy column too; that mirroring is
    // decided in SQL, where the CHECK constraint lives.
    expect(out.role).toBe('supervisor')
  })

  it('passes only the slug for a custom role, leaving the legacy column to SQL', async () => {
    const before = makeProfile({ id: 'u-2', role: 'soporte', role_key: 'soporte' })
    setUpFindUser(before)
    const roleQ = new QueryMock()
    roleQ.payload = { data: { key: 'auditor', is_system: false }, error: null }
    mockAdmin.from.mockReturnValueOnce(roleQ)

    await users.updateUser('u-2', { role: 'auditor' }, 'u-1')
    // A custom slug cannot pass the legacy check constraint, so SQL leaves
    // that column alone. role_key is the source of truth.
    expect(mockAdmin.rpc).toHaveBeenCalledWith(
      'admin_update_profile',
      expect.objectContaining({ p_role_key: 'auditor' }),
    )
  })

  it('rejects a role that does not exist', async () => {
    const before = makeProfile({ id: 'u-2', role: 'soporte', role_key: 'soporte' })
    setUpFindUser(before)
    const roleQ = new QueryMock()
    roleQ.payload = { data: null, error: null }
    mockAdmin.from.mockReturnValueOnce(roleQ)

    await expect(users.updateUser('u-2', { role: 'ghost' }, 'u-1')).rejects.toMatchObject({
      code: 'role_not_found',
    })
    expect(mockAdmin.rpc).not.toHaveBeenCalled()
  })

  it('does not write when role patch equals current role', async () => {
    const before = makeProfile({ id: 'u-2', role: 'admin', role_key: 'admin' })
    setUpFindUser(before)
    // No write expected; if it were, the rpc mock would record it.
    const out = await users.updateUser('u-2', { role: 'admin' }, 'u-1')
    expect(out.id).toBe('u-2')
    expect(mockAdmin.rpc).not.toHaveBeenCalled()
  })

  it('suspends user when patch.suspend is true and user is currently active', async () => {
    const before = makeProfile({ id: 'u-2', suspended_at: null })
    setUpFindUser(before)

    const out = await users.updateUser('u-2', { suspend: true }, 'u-1')
    expect(out.suspended_at).toBeTruthy()
    expect((out as unknown as Record<string, unknown>).suspended_by).toBe('u-1')
    expect(mockAdmin.rpc).toHaveBeenCalledWith(
      'admin_update_profile',
      expect.objectContaining({ p_suspend: true, p_actor: 'u-1' }),
    )
  })

  it('reactivates user when patch.suspend is false and user is currently suspended', async () => {
    const before = makeProfile({ id: 'u-2', suspended_at: '2026-01-15T00:00:00Z' })
    setUpFindUser(before)

    const out = await users.updateUser('u-2', { suspend: false }, 'u-1')
    expect(out.suspended_at).toBeNull()
    expect(mockAdmin.rpc).toHaveBeenCalledWith(
      'admin_update_profile',
      expect.objectContaining({ p_suspend: false }),
    )
  })

  it('does not write when suspension state already matches', async () => {
    const before = makeProfile({ id: 'u-2', suspended_at: null })
    setUpFindUser(before)
    const out = await users.updateUser('u-2', { suspend: false }, 'u-1')
    expect(out.id).toBe('u-2')
    expect(mockAdmin.rpc).not.toHaveBeenCalled()
  })

  it('trims display_name on patch', async () => {
    const before = makeProfile({ id: 'u-2', display_name: 'Alice' })
    setUpFindUser(before)

    const out = await users.updateUser('u-2', { display_name: '  Alice Cooper  ' }, 'u-1')
    expect(out.display_name).toBe('Alice Cooper')
    expect(mockAdmin.rpc).toHaveBeenCalledWith(
      'admin_update_profile',
      expect.objectContaining({ p_display_name: 'Alice Cooper' }),
    )
  })

  it('propagates Supabase errors from the transactional write', async () => {
    const before = makeProfile({ id: 'u-2', role: 'soporte', role_key: 'soporte' })
    setUpFindUser(before)
    const roleQ = new QueryMock()
    roleQ.payload = { data: { key: 'admin', is_system: true }, error: null }
    mockAdmin.from.mockReturnValueOnce(roleQ)
    mockAdmin.rpc.mockResolvedValue({ data: null, error: { message: 'db down' } })
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

// ---------------------------------------------------------------------------
// createUser — the two-step write that must not leave half an account
// ---------------------------------------------------------------------------

describe('createUser', () => {
  function roleQ(key: string, isSystem = false) {
    const q = new QueryMock()
    q.payload = { data: { key, is_system: isSystem }, error: null }
    return q
  }
  // The profile row is created by the handle_new_user trigger, so this service
  // updates it — never inserts. A mock cannot model the trigger, which is
  // exactly why the live smoke test exists.
  function updateQ(ok: boolean) {
    const q = new QueryMock()
    q.payload = ok
      ? { data: null, error: null }
      : { data: null, error: { message: 'profiles update failed' } }
    return q
  }

  it('creates the auth user and configures the trigger-made profile', async () => {
    mockAdmin.from
      .mockReturnValueOnce(roleQ('soporte', true))
      .mockReturnValueOnce(updateQ(true))
    mockAdmin.auth.admin.createUser.mockResolvedValue({
      data: { user: { id: 'new-1', email: 'nuevo@x.com', created_at: '2026-01-01' } },
      error: null,
    })

    const out = await users.createUser(
      { email: '  Nuevo@X.com ', password: 'abcd1234', display_name: ' Nueva ' },
      'admin-1',
    )

    expect(out.id).toBe('new-1')
    expect(out.email).toBe('nuevo@x.com') // lowercased + trimmed
    expect(out.role_key).toBe('soporte')
    expect(mockAdmin.auth.admin.createUser).toHaveBeenCalledWith({
      email: 'nuevo@x.com',
      password: 'abcd1234',
      email_confirm: true,
      user_metadata: { display_name: 'Nueva' },
    })
  })

  it('deletes the auth user when the profile update fails', async () => {
    // The failure mode this guards: an identity with no profiles row can sign
    // in and is then rejected by every route, which reads as a bad password
    // and cannot be fixed from the UI.
    mockAdmin.from
      .mockReturnValueOnce(roleQ('soporte', true))
      .mockReturnValueOnce(updateQ(false))
    mockAdmin.auth.admin.createUser.mockResolvedValue({
      data: { user: { id: 'new-2', email: 'x@y.com', created_at: '2026-01-01' } },
      error: null,
    })

    await expect(
      users.createUser({ email: 'x@y.com', password: 'abcd1234' }, 'admin-1'),
    ).rejects.toMatchObject({ code: 'profile_failed' })

    expect(mockAdmin.auth.admin.deleteUser).toHaveBeenCalledWith('new-2')
  })

  it('rejects an unknown role before creating anything in Auth', async () => {
    const missing = new QueryMock()
    missing.payload = { data: null, error: null }
    mockAdmin.from.mockReturnValueOnce(missing)

    await expect(
      users.createUser(
        { email: 'x@y.com', password: 'abcd1234', role_key: 'inventado' },
        'admin-1',
      ),
    ).rejects.toMatchObject({ code: 'role_not_found' })

    expect(mockAdmin.auth.admin.createUser).not.toHaveBeenCalled()
  })

  it('maps an already-registered email to email_taken, not a 500', async () => {
    mockAdmin.from.mockReturnValueOnce(roleQ('soporte', true))
    mockAdmin.auth.admin.createUser.mockResolvedValue({
      data: { user: null },
      error: { message: 'User already registered' },
    })

    await expect(
      users.createUser({ email: 'dupe@x.com', password: 'abcd1234' }, 'admin-1'),
    ).rejects.toMatchObject({ code: 'email_taken' })
  })

  it('omits the legacy role column for a custom role', async () => {
    mockAdmin.from
      .mockReturnValueOnce(roleQ('auditor'))
      .mockReturnValueOnce(updateQ(true))
    mockAdmin.auth.admin.createUser.mockResolvedValue({
      data: { user: { id: 'new-3', email: 'a@b.com', created_at: '2026-01-01' } },
      error: null,
    })

    await users.createUser(
      { email: 'a@b.com', password: 'abcd1234', role_key: 'auditor' },
      'admin-1',
    )

    const updated = mockAdmin.from.mock.results[1]!.value as QueryMock
    const row = updated.ops.find((o) => o.op === 'update')!.args[0] as Record<string, unknown>
    // The column has a check constraint for the three shipped slugs; a custom
    // key would be rejected by the DB, so it must not be sent.
    expect(row.role_key).toBe('auditor')
    expect(row).not.toHaveProperty('role')
  })
})

// ---------------------------------------------------------------------------
// updateOwnProfile — two fields, nothing else
// ---------------------------------------------------------------------------

describe('updateOwnProfile', () => {
  it('normalizes an empty phone to null rather than rejecting it', async () => {
    const upd = new QueryMock()
    upd.payload = { data: null, error: null }
    const read = new QueryMock()
    read.payload = { data: { display_name: 'Ana', phone: null }, error: null }
    mockAdmin.from.mockReturnValueOnce(upd).mockReturnValueOnce(read)

    const out = await users.updateOwnProfile('u-1', { phone: '   ' })
    expect(out.phone).toBeNull()
    const row = upd.ops.find((o) => o.op === 'update')!.args[0] as Record<string, unknown>
    expect(row.phone).toBeNull()
  })

  it('strips letters out of the phone and keeps the digits', async () => {
    const upd = new QueryMock()
    upd.payload = { data: null, error: null }
    const read = new QueryMock()
    read.payload = { data: { display_name: 'Ana', phone: '+52 555 1234567' }, error: null }
    mockAdmin.from.mockReturnValueOnce(upd).mockReturnValueOnce(read)

    await users.updateOwnProfile('u-1', { phone: 'llama a +52 555 1234567' })
    const row = upd.ops.find((o) => o.op === 'update')!.args[0] as Record<string, unknown>
    expect(row.phone).toBe('+52 555 1234567')
  })

  it('writes nothing when the patch is empty', async () => {
    const read = new QueryMock()
    read.payload = { data: { display_name: 'Ana', phone: null }, error: null }
    mockAdmin.from.mockReturnValueOnce(read)

    await users.updateOwnProfile('u-1', {})
    const q = mockAdmin.from.mock.results[0]!.value as QueryMock
    expect(q.ops.find((o) => o.op === 'update')).toBeUndefined()
  })
})

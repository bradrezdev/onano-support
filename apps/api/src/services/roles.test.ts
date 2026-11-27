import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Supabase query mock.
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
  is(col: string, val: unknown) { return this.record('is', [col, val]) }
  not(col: string, op: string, val: unknown) { return this.record('not', [col, op, val]) }
  insert(rows: unknown) { return this.record('insert', [rows]) }
  update(rows: unknown) { return this.record('update', [rows]) }
  delete() { return this.record('delete', []) }
  order() { return this }
  limit() { return this }
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
}

vi.mock('@/lib/supabase/admin', () => ({
  createSupabaseAdminClient: () => mockAdmin,
}))

const roles = await import('./roles')

beforeEach(() => {
  mockAdmin.from.mockReset()
  mockAdmin.rpc.mockReset()
  mockAdmin.rpc.mockResolvedValue({ data: null, error: null })
})

function setNextFrom(payload: Response): QueryMock {
  const q = new QueryMock()
  q.payload = payload
  mockAdmin.from.mockReturnValueOnce(q)
  return q
}

function makeRole(over: Record<string, unknown> = {}) {
  return {
    id: 'role-1',
    key: 'auditor',
    name: 'Auditor',
    description: null,
    color: '#0ea5e9',
    is_system: false,
    created_at: '2026-01-01T00:00:00Z',
    ...over,
  }
}

// ---------------------------------------------------------------------------
// listRoles
// ---------------------------------------------------------------------------

describe('listRoles', () => {
  it('groups permissions per role and counts members', async () => {
    setNextFrom({ data: [makeRole(), makeRole({ id: 'role-2', key: 'admin', is_system: true })], error: null })
    setNextFrom({
      data: [
        { role_id: 'role-1', permission_key: 'ticket.reply' },
        { role_id: 'role-1', permission_key: 'conversation.read' },
        { role_id: 'role-2', permission_key: 'ticket.reply' },
      ],
      error: null,
    })
    setNextFrom({ data: [{ role_key: 'auditor' }, { role_key: 'auditor' }, { role_key: null }], error: null })

    const out = await roles.listRoles()

    const auditor = out.find((r) => r.key === 'auditor')!
    expect(auditor.permissions).toEqual(['conversation.read', 'ticket.reply'])
    expect(auditor.user_count).toBe(2)
    expect(out.find((r) => r.key === 'admin')!.user_count).toBe(0)
  })

  it('drops unknown permission keys from the catalogue', async () => {
    setNextFrom({ data: [makeRole()], error: null })
    setNextFrom({
      data: [
        { role_id: 'role-1', permission_key: 'ticket.reply' },
        { role_id: 'role-1', permission_key: 'not.a.real.key' },
      ],
      error: null,
    })
    setNextFrom({ data: [], error: null })

    const out = await roles.listRoles()
    expect(out[0]!.permissions).toEqual(['ticket.reply'])
  })

  it('gives a role with no keys an empty keyring rather than failing', async () => {
    setNextFrom({ data: [makeRole()], error: null })
    setNextFrom({ data: [], error: null })
    setNextFrom({ data: [], error: null })

    const out = await roles.listRoles()
    // An empty keyring is valid and visible — the "gafete en blanco" case.
    expect(out[0]!.permissions).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// createRole
// ---------------------------------------------------------------------------

describe('createRole', () => {
  const valid = {
    key: 'auditor',
    name: 'Auditor',
    color: '#0ea5e9',
    permissions: ['ticket.reply' as const],
  }

  it('rejects a malformed key', async () => {
    await expect(
      roles.createRole({ ...valid, key: 'Auditor Con Espacios' }, 'u-1'),
    ).rejects.toMatchObject({ code: 'invalid_key' })
  })

  it('rejects a key that does not start with a letter', async () => {
    await expect(roles.createRole({ ...valid, key: '1auditor' }, 'u-1')).rejects.toMatchObject({
      code: 'invalid_key',
    })
  })

  it('rejects an empty name', async () => {
    await expect(roles.createRole({ ...valid, name: '   ' }, 'u-1')).rejects.toMatchObject({
      code: 'invalid_name',
    })
  })

  it('rejects a color that is not a 6-digit hex', async () => {
    await expect(roles.createRole({ ...valid, color: 'blue' }, 'u-1')).rejects.toMatchObject({
      code: 'invalid_color',
    })
  })

  it('rejects a duplicate key', async () => {
    setNextFrom({ data: { id: 'role-1', is_system: false }, error: null })
    await expect(roles.createRole(valid, 'u-1')).rejects.toMatchObject({
      code: 'duplicate_key',
      status: 409,
    })
  })

  it('creates a role with no permissions at all', async () => {
    setNextFrom({ data: null, error: null }) // duplicate check -> none
    const insertQ = setNextFrom({ data: makeRole(), error: null })

    const out = await roles.createRole({ ...valid, permissions: [] }, 'u-1')

    expect(insertQ.ops.find((o) => o.op === 'insert')?.args[0]).toMatchObject({
      key: 'auditor',
      is_system: false,
      created_by: 'u-1',
    })
    // The keyring is replaced through the transactional function, with an
    // empty list: the role keeps no permissions and the swap is audited.
    expect(mockAdmin.rpc).toHaveBeenCalledWith('admin_replace_role_permissions', {
      p_role_id: 'role-1',
      p_permission_keys: [],
      p_actor: 'u-1',
    })
    expect(out.permissions).toEqual([])
  })

  it('writes the keyring after creating the role', async () => {
    setNextFrom({ data: null, error: null })
    setNextFrom({ data: makeRole(), error: null })

    const out = await roles.createRole(valid, 'u-1')

    // One call replaces the whole keyring and leaves the audit entry in the
    // same transaction.
    expect(mockAdmin.rpc).toHaveBeenCalledWith('admin_replace_role_permissions', {
      p_role_id: 'role-1',
      p_permission_keys: ['ticket.reply'],
      p_actor: 'u-1',
    })
    expect(out.permissions).toEqual(['ticket.reply'])
  })

  it('rejects a permission that is not in the catalogue', async () => {
    setNextFrom({ data: null, error: null })
    setNextFrom({ data: makeRole(), error: null })
    await expect(
      roles.createRole({ ...valid, permissions: ['not.real' as never] }, 'u-1'),
    ).rejects.toMatchObject({ code: 'unknown_permission' })
  })
})

// ---------------------------------------------------------------------------
// deleteRole
// ---------------------------------------------------------------------------

describe('deleteRole', () => {
  it('refuses to delete a system role', async () => {
    setNextFrom({ data: makeRole({ is_system: true, key: 'admin' }), error: null })
    await expect(roles.deleteRole('role-1')).rejects.toMatchObject({
      code: 'system_role',
      status: 409,
    })
  })

  it('refuses to delete a role that still has members', async () => {
    setNextFrom({ data: makeRole(), error: null })
    setNextFrom({ data: [{ id: 'u-9' }], error: null })
    await expect(roles.deleteRole('role-1')).rejects.toMatchObject({
      code: 'role_in_use',
      status: 409,
    })
  })

  it('deletes an unused custom role', async () => {
    setNextFrom({ data: makeRole(), error: null })
    setNextFrom({ data: [], error: null })
    const delQ = setNextFrom({ data: null, error: null })

    await expect(roles.deleteRole('role-1')).resolves.toEqual({ deleted: true })
    expect(delQ.ops.some((o) => o.op === 'delete')).toBe(true)
  })

  it('reports 404 for an unknown role', async () => {
    setNextFrom({ data: null, error: null })
    await expect(roles.deleteRole('nope')).rejects.toMatchObject({
      code: 'not_found',
      status: 404,
    })
  })
})

// ---------------------------------------------------------------------------
// updateRole
// ---------------------------------------------------------------------------

describe('updateRole', () => {
  it('updates name and color without touching the key', async () => {
    setNextFrom({ data: makeRole(), error: null }) // findRoleOrThrow (before)
    const updQ = setNextFrom({ data: null, error: null })
    setNextFrom({ data: makeRole({ name: 'Auditor Senior' }), error: null }) // findRoleOrThrow (after)

    await roles.updateRole('role-1', { name: 'Auditor Senior', color: '#111111' }, 'u-1')

    expect(updQ.ops.find((o) => o.op === 'update')?.args[0]).toEqual({
      name: 'Auditor Senior',
      color: '#111111',
    })
    // `key` is not in the patch type at all — it is not editable.
  })

  it('rejects an invalid color', async () => {
    setNextFrom({ data: makeRole(), error: null })
    await expect(roles.updateRole('role-1', { color: 'rojo' }, 'u-1')).rejects.toMatchObject({
      code: 'invalid_color',
    })
  })

  it('replaces the keyring when permissions are provided', async () => {
    // Patch has no name/color, so no roles.update call: only the keyring swap.
    setNextFrom({ data: makeRole(), error: null }) // findRoleOrThrow (before)
    setNextFrom({ data: makeRole(), error: null }) // findRoleOrThrow (after)

    await roles.updateRole('role-1', { permissions: ['ticket.reply', 'ticket.close'] }, 'u-1')

    // The swap is one transactional call, not a delete followed by an insert.
    expect(mockAdmin.rpc).toHaveBeenCalledWith('admin_replace_role_permissions', {
      p_role_id: 'role-1',
      p_permission_keys: ['ticket.reply', 'ticket.close'],
      p_actor: 'u-1',
    })
  })

  it('propagates the error when the transactional swap fails', async () => {
    setNextFrom({ data: makeRole(), error: null }) // findRoleOrThrow (before)
    mockAdmin.rpc.mockResolvedValue({ data: null, error: { message: 'db down' } })

    await expect(
      roles.updateRole('role-1', { permissions: ['ticket.reply'] }, 'u-1'),
    ).rejects.toBeDefined()
  })
})
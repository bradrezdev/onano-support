import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockRequireRole = vi.fn()

// Supabase admin client — needed because the route calls
// createSupabaseAdminClient directly for category insert.
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
  eq(_col: string, _val: unknown) { return this }
  order(_col: string, _opts?: unknown) { return this }
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
}

vi.mock('@/lib/auth', () => ({
  requireUser: vi.fn(),
    requirePermission: (...args: unknown[]) => mockRequireRole(...args),
  requireAllPermissions: (...args: unknown[]) => mockRequireRole(...args),requireRole: (...args: unknown[]) => mockRequireRole(...args),
  getCurrentUser: vi.fn(),
}))

vi.mock('@/lib/supabase/admin', () => ({
  createSupabaseAdminClient: () => mockAdmin,
}))

const { POST } = await import('./route')

beforeEach(() => {
  mockRequireRole.mockReset()
  mockAdmin.from.mockReset()
})

function okAuthAdmin() {
  mockRequireRole.mockResolvedValue({
    user: {
      id: 'u-admin',
      email: 'a@x',
      role: 'admin',
      display_name: 'Admin',
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

const PARENT_UUID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479'

function postReq(body: unknown) {
  return new Request('http://x/api/categories', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })
}

describe('POST /api/categories — auth', () => {
  it('returns 401 when unauthorized', async () => {
    denyAuth(401, 'unauthorized', 'Not signed in')
    const res = await POST(postReq({ name: 'Billing' }))
    expect(res.status).toBe(401)
  })

  it('returns 403 when role is not admin', async () => {
    denyAuth(403, 'forbidden', 'Requires role: admin')
    const res = await POST(postReq({ name: 'Billing' }))
    expect(res.status).toBe(403)
  })
})

describe('POST /api/categories — Zod', () => {
  beforeEach(() => okAuthAdmin())

  it('returns 400 validation_failed when name is empty', async () => {
    const res = await POST(postReq({ name: '' }))
    expect(res.status).toBe(400)
  })

  it('returns 400 validation_failed when name exceeds 120 chars', async () => {
    const res = await POST(postReq({ name: 'x'.repeat(121) }))
    expect(res.status).toBe(400)
  })

  it('returns 400 validation_failed when parent_id is not a UUID', async () => {
    const res = await POST(postReq({ name: 'Billing', parent_id: 'not-a-uuid' }))
    expect(res.status).toBe(400)
  })

  it('returns 400 when description exceeds 500 chars', async () => {
    const res = await POST(postReq({ name: 'Billing', description: 'x'.repeat(501) }))
    expect(res.status).toBe(400)
  })
})

describe('POST /api/categories — parent validation', () => {
  beforeEach(() => okAuthAdmin())

  it('returns 400 invalid_parent when parent does not exist', async () => {
    const findQ = new QueryMock()
    findQ.payload = { data: null, error: null }
    mockAdmin.from.mockReturnValueOnce(findQ)
    const res = await POST(postReq({ name: 'Refunds', parent_id: PARENT_UUID }))
    expect(res.status).toBe(400)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe('invalid_parent')
  })

  it('returns 400 too_deep when parent itself is a sub-category', async () => {
    const findQ = new QueryMock()
    findQ.payload = { data: { id: PARENT_UUID, parent_id: 'grandparent-uuid' }, error: null }
    mockAdmin.from.mockReturnValueOnce(findQ)
    const res = await POST(postReq({ name: 'Sub-sub', parent_id: PARENT_UUID }))
    expect(res.status).toBe(400)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe('too_deep')
  })

  it('proceeds when parent is a top-level category', async () => {
    const findQ = new QueryMock()
    findQ.payload = { data: { id: PARENT_UUID, parent_id: null }, error: null }
    const insertQ = new QueryMock()
    insertQ.payload = {
      data: { id: 'c-new', parent_id: PARENT_UUID, name: 'Refunds', description: null, created_by: 'u-admin', created_at: 'x', updated_at: 'x' },
      error: null,
    }
    mockAdmin.from.mockReturnValueOnce(findQ).mockReturnValueOnce(insertQ)
    const res = await POST(postReq({ name: 'Refunds', parent_id: PARENT_UUID }))
    expect(res.status).toBe(201)
  })
})

describe('POST /api/categories — happy path + errors', () => {
  beforeEach(() => okAuthAdmin())

  it('trims name before insert and returns 201 with row', async () => {
    const insertQ = new QueryMock()
    insertQ.payload = {
      data: { id: 'c-new', parent_id: null, name: 'Billing', description: null, created_by: 'u-admin', created_at: 'x', updated_at: 'x' },
      error: null,
    }
    mockAdmin.from.mockReturnValueOnce(insertQ)
    const res = await POST(postReq({ name: '  Billing  ' }))
    expect(res.status).toBe(201)
    const insertRow = insertQ.ops.find((o) => o.op === 'insert')!.args[0] as Record<string, unknown>
    expect(insertRow.name).toBe('Billing')
    expect(insertRow.created_by).toBe('u-admin')
  })

  it('maps Postgres unique violation (23505) to 409 duplicate', async () => {
    const insertQ = new QueryMock()
    insertQ.payload = { data: null, error: { code: '23505', message: 'dup' } }
    mockAdmin.from.mockReturnValueOnce(insertQ)
    const res = await POST(postReq({ name: 'Billing' }))
    expect(res.status).toBe(409)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe('duplicate')
  })

  it('maps other Postgres errors to 500 db_error', async () => {
    const insertQ = new QueryMock()
    insertQ.payload = { data: null, error: { code: '9999', message: 'db down' } }
    mockAdmin.from.mockReturnValueOnce(insertQ)
    const res = await POST(postReq({ name: 'Billing' }))
    expect(res.status).toBe(500)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe('db_error')
  })
})

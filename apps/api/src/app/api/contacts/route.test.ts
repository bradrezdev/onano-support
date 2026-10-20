import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockRequireRole = vi.fn()

// Supabase admin client — POST /api/contacts calls createSupabaseAdminClient
// directly to insert the row.
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
  range(_start: number, _end: number) { return this }
  ilike(_col: string, _val: string) { return this }
  is(_col: string, _val: unknown) { return this }
  insert(rows: unknown) { return this.record('insert', [rows]) }
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
  requireRole: (...args: unknown[]) => mockRequireRole(...args),
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

function okAuth() {
  mockRequireRole.mockResolvedValue({
    user: {
      id: 'u-1', email: 'u@x', role: 'soporte',
      display_name: 'U', suspended_at: null, deleted_at: null,
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
  return new Request('http://x/api/contacts', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })
}

const valid = {
  whatsapp_number: '+541112345678',
  name: 'Juan Pérez',
  email: 'juan@example.com',
  country: 'Argentina',
  country_code: 'ar',
}

describe('POST /api/contacts — auth', () => {
  it('returns 401 when unauthorized', async () => {
    denyAuth(401, 'unauthorized', 'Not signed in')
    const res = await POST(postReq(valid))
    expect(res.status).toBe(401)
  })

  it('allows admin, supervisor, soporte', async () => {
    for (const role of ['admin', 'supervisor', 'soporte'] as const) {
      mockRequireRole.mockReset()
      mockAdmin.from.mockReset()
      okAuth()
      const insertQ = new QueryMock()
      insertQ.payload = { data: { id: 'co-1', ...valid }, error: null }
      mockAdmin.from.mockReturnValueOnce(insertQ)
      const res = await POST(postReq(valid))
      expect(res.status).toBe(201)
    }
  })
})

describe('POST /api/contacts — Zod', () => {
  beforeEach(() => okAuth())

  it('returns 400 when name is empty', async () => {
    const res = await POST(postReq({ ...valid, name: '' }))
    expect(res.status).toBe(400)
  })

  it('returns 400 when whatsapp_number is too short', async () => {
    const res = await POST(postReq({ ...valid, whatsapp_number: '1234' }))
    expect(res.status).toBe(400)
  })

  it('returns 400 when email is malformed', async () => {
    const res = await POST(postReq({ ...valid, email: 'not-an-email' }))
    expect(res.status).toBe(400)
  })

  it('returns 400 when country_code is not 2 chars', async () => {
    const res = await POST(postReq({ ...valid, country_code: 'ARG' }))
    expect(res.status).toBe(400)
  })
})

describe('POST /api/contacts — phone normalization', () => {
  beforeEach(() => okAuth())

  it('rejects with 400 invalid_phone when number has fewer than 8 digits', async () => {
    const res = await POST(postReq({ ...valid, whatsapp_number: '+1234567' }))
    expect(res.status).toBe(400)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe('invalid_phone')
  })

  it('normalizes input to E.164 before insert', async () => {
    const insertQ = new QueryMock()
    insertQ.payload = { data: { id: 'co-1', ...valid, whatsapp_number: '+5491145678901' }, error: null }
    mockAdmin.from.mockReturnValueOnce(insertQ)
    const res = await POST(postReq({ ...valid, whatsapp_number: '+54 911 4567-8901' }))
    expect(res.status).toBe(201)
    const insertedRow = insertQ.ops.find((o) => o.op === 'insert')!.args[0] as Record<string, unknown>
    expect(insertedRow.whatsapp_number).toBe('+5491145678901')
  })

  it('uppercases country_code', async () => {
    const insertQ = new QueryMock()
    insertQ.payload = { data: { id: 'co-1', ...valid }, error: null }
    mockAdmin.from.mockReturnValueOnce(insertQ)
    const res = await POST(postReq({ ...valid, country_code: 'ar' }))
    expect(res.status).toBe(201)
    const insertedRow = insertQ.ops.find((o) => o.op === 'insert')!.args[0] as Record<string, unknown>
    expect(insertedRow.country_code).toBe('AR')
  })
})

describe('POST /api/contacts — duplicate + error', () => {
  beforeEach(() => okAuth())

  it('maps 23505 to 409 duplicate', async () => {
    const insertQ = new QueryMock()
    insertQ.payload = { data: null, error: { code: '23505', message: 'dup' } }
    mockAdmin.from.mockReturnValueOnce(insertQ)
    const res = await POST(postReq(valid))
    expect(res.status).toBe(409)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe('duplicate')
  })

  it('maps other DB errors to 500 db_error', async () => {
    const insertQ = new QueryMock()
    insertQ.payload = { data: null, error: { code: '9999', message: 'db down' } }
    mockAdmin.from.mockReturnValueOnce(insertQ)
    const res = await POST(postReq(valid))
    expect(res.status).toBe(500)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe('db_error')
  })
})

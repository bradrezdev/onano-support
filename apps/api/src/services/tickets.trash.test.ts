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
  delete() { return this }
  order() { return this }
  range() { return this }
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
}

vi.mock('@/lib/supabase/admin', () => ({
  createSupabaseAdminClient: () => mockAdmin,
}))

const tickets = await import('./tickets')

beforeEach(() => {
  mockAdmin.from.mockReset()
})

function setNextFrom(payload: Response): QueryMock {
  const q = new QueryMock()
  q.payload = payload
  mockAdmin.from.mockReturnValueOnce(q)
  return q
}

function makeTicket(over: Record<string, unknown> = {}) {
  return {
    id: 'tk-1',
    contact_id: 'ct-1',
    category_id: 'cg-1',
    assigned_to: null,
    theme_id: null,
    flow_id: null,
    name: 'Pago rechazado',
    description: {},
    description_plain: 'x',
    status: 'open',
    created_by: 'u-1',
    closed_by: null,
    closed_at: null,
    reopened_by: null,
    reopened_at: null,
    deleted_at: null,
    deleted_by: null,
    created_at: '2026-01-01',
    updated_at: '2026-01-01',
    ...over,
  }
}

// ---------------------------------------------------------------------------
// findTicketOrThrow — the trash guard
// ---------------------------------------------------------------------------

describe('findTicketOrThrow', () => {
  it('filters trashed tickets out by default', async () => {
    const q = setNextFrom({ data: makeTicket(), error: null })
    await tickets.findTicketOrThrow('tk-1')
    const is = q.ops.find((o) => o.op === 'is')
    expect(is?.args).toEqual(['deleted_at', null])
  })

  it('skips the filter when includeTrashed is set', async () => {
    const q = setNextFrom({ data: makeTicket({ deleted_at: '2026-01-02' }), error: null })
    await tickets.findTicketOrThrow('tk-1', { includeTrashed: true })
    expect(q.ops.some((o) => o.op === 'is')).toBe(false)
  })

  it('throws not_found when the trashed ticket is filtered out', async () => {
    setNextFrom({ data: null, error: null })
    await expect(tickets.findTicketOrThrow('tk-1')).rejects.toMatchObject({ code: 'not_found' })
  })
})

// ---------------------------------------------------------------------------
// Mutations refuse to touch a trashed ticket
// ---------------------------------------------------------------------------

describe('mutations refuse a trashed ticket', () => {
  it('closeTicket surfaces not_found instead of closing', async () => {
    setNextFrom({ data: null, error: null })
    await expect(tickets.closeTicket('tk-1', 'u-1')).rejects.toMatchObject({
      code: 'not_found',
    })
  })

  it('reopenTicket surfaces not_found', async () => {
    setNextFrom({ data: null, error: null })
    await expect(tickets.reopenTicket('tk-1', 'u-1')).rejects.toMatchObject({
      code: 'not_found',
    })
  })

  it('updateTicket surfaces not_found', async () => {
    setNextFrom({ data: null, error: null })
    await expect(tickets.updateTicket('tk-1', { name: 'Nuevo' }, 'u-1')).rejects.toMatchObject({
      code: 'not_found',
    })
  })
})

// ---------------------------------------------------------------------------
// trashTicket / restoreTicket
// ---------------------------------------------------------------------------

describe('trashTicket', () => {
  it('sets deleted_at and deleted_by instead of removing the row', async () => {
    setNextFrom({ data: makeTicket(), error: null }) // findTicketOrThrow
    const updateQ = setNextFrom({
      data: makeTicket({ deleted_at: '2026-02-02', deleted_by: 'u-1' }),
      error: null,
    })
    const historyQ = setNextFrom({ data: null, error: null })

    const result = await tickets.trashTicket('tk-1', 'u-1')

    const written = updateQ.ops.find((o) => o.op === 'update')?.args[0] as Record<string, unknown>
    expect(written.deleted_by).toBe('u-1')
    expect(written.deleted_at).toEqual(expect.any(String))
    // Soft delete: the WHERE clause guards against double-trash.
    expect(updateQ.ops.some((o) => o.op === 'is' && o.args[0] === 'deleted_at')).toBe(true)

    const history = historyQ.ops.find((o) => o.op === 'insert')?.args[0] as Record<string, unknown>
    expect(history.action).toBe('trashed')
    expect(history.actor_id).toBe('u-1')

    // Returns the pre-trash snapshot so the caller can show "was: open".
    expect(result.status).toBe('open')
  })

  it('reports already_trashed when the row was already hidden', async () => {
    setNextFrom({ data: makeTicket(), error: null })
    setNextFrom({ data: null, error: null })
    await expect(tickets.trashTicket('tk-1', 'u-1')).rejects.toMatchObject({
      code: 'already_trashed',
    })
  })
})

describe('restoreTicket', () => {
  it('clears the trash markers and writes history', async () => {
    const updateQ = setNextFrom({ data: makeTicket(), error: null })
    const historyQ = setNextFrom({ data: null, error: null })

    await tickets.restoreTicket('tk-1', 'u-1')

    expect(updateQ.ops.find((o) => o.op === 'update')?.args[0]).toEqual({
      deleted_at: null,
      deleted_by: null,
    })
    const history = historyQ.ops.find((o) => o.op === 'insert')?.args[0] as Record<string, unknown>
    expect(history.action).toBe('restored')
  })

  it('reports not_trashed when the ticket is live', async () => {
    setNextFrom({ data: null, error: null })
    await expect(tickets.restoreTicket('tk-1', 'u-1')).rejects.toMatchObject({
      code: 'not_trashed',
    })
  })
})
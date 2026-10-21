import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Supabase query mock — each bucket of the inbox service runs exactly one
// chain (.select -> ... -> await), so each test queues one mock per bucket.
// ---------------------------------------------------------------------------

type Response = { data: unknown; error?: unknown; count?: number | null }
type Op = { op: string; args: unknown[] }

class QueryMock {
  ops: Op[] = []
  payload: Response = { data: null, error: null, count: 0 }

  private record(op: string, args: unknown[]): this {
    this.ops.push({ op, args })
    return this
  }
  select(...args: unknown[]) { return this.record('select', args) }
  eq(col: string, val: unknown) { return this.record('eq', [col, val]) }
  is(col: string, val: unknown) { return this.record('is', [col, val]) }
  not(col: string, op: string, val: unknown) { return this.record('not', [col, op, val]) }
  lt(col: string, val: unknown) { return this.record('lt', [col, val]) }
  gt(col: string, val: unknown) { return this.record('gt', [col, val]) }
  order(...args: unknown[]) { return this.record('order', args) }
  limit(n: number) { return this.record('limit', [n]) }
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

const inbox = await import('./inbox')

beforeEach(() => {
  mockAdmin.from.mockReset()
  // The service awaits a chain on the same QueryMock. Each `.from(...)`
  // call hands back one QueryMock until it is awaited; `.mockReturnValue`
  // reuses the same mock across calls, which means we need a brand-new
  // QueryMock per bucket that also responds to the awaited then(). Putting
  // the same mock behind all four calls therefore short-circuits on the first
  // resolved one. So: queue one mock per call via mockImplementationOnce,
  // then patch each mock onto the from-call order with the data attached.
})

function queueBuckets(buckets: Response[]): void {
  // Schedule one mock per bucket in the order Promise.all sees them:
  // mine, unassigned, overdue, unread (matches getMyInbox).
  for (const payload of buckets) {
    mockAdmin.from.mockImplementationOnce(() => {
      const q = new QueryMock()
      q.payload = payload
      return q
    })
  }
}

function makeTicket(over: Record<string, unknown> = {}) {
  return {
    id: 'tk-1',
    name: 'Pago rechazado',
    status: 'open',
    updated_at: '2026-01-01',
    due_at: null,
    contacts: [{ name: 'Ana' }],
    ...over,
  }
}

function makeConversation(over: Record<string, unknown> = {}) {
  return {
    id: 'cv-1',
    last_message_at: '2026-01-01',
    unread_count: 2,
    contacts: [{ name: 'Ana' }],
    ...over,
  }
}

describe('getMyInbox (D1)', () => {
  it('returns the four buckets with their counts', async () => {
    queueBuckets([
      { data: [makeTicket()], count: 7 },
      { data: [makeTicket({ id: 'tk-2' })], count: 3 },
      { data: [], count: 0 },
      { data: [makeConversation()], count: 4 },
    ])

    const out = await inbox.getMyInbox('u-1')

    expect(mockAdmin.from).toHaveBeenCalledTimes(4)
    expect(out.mine).toEqual({ count: 7, rows: [expect.objectContaining({ id: 'tk-1' })] })
    expect(out.unassigned.count).toBe(3)
    expect(out.overdue.count).toBe(0)
    expect(out.unread.count).toBe(4)
  })

  it('scopes mine to the caller and uses is(null) for unassigned', async () => {
    const calls: QueryMock[] = []
    for (const payload of [{ data: [], count: 0 }, { data: [], count: 0 }, { data: [], count: 0 }, { data: [], count: 0 }]) {
      const q = new QueryMock()
      q.payload = payload
      calls.push(q)
    }
    calls.forEach((q) => mockAdmin.from.mockReturnValueOnce(q))

    await inbox.getMyInbox('u-agent-7')

    // The order is mine, unassigned, overdue, unread.
    const mine = calls[0]!
    const unassigned = calls[1]!
    const eqs = mine.ops.filter((o) => o.op === 'eq')
    expect(eqs.map((o) => o.args)).toContainEqual(['assigned_to', 'u-agent-7'])
    expect(eqs.map((o) => o.args)).toContainEqual(['status', 'open'])
    const isss = unassigned.ops.filter((o) => o.op === 'is').map((o) => o.args)
    expect(isss).toContainEqual(['assigned_to', null])
    expect(isss).toContainEqual(['deleted_at', null])
  })

  it('a ticket without due_at is never counted as overdue', async () => {
    const calls: QueryMock[] = []
    for (let i = 0; i < 4; i++) {
      const q = new QueryMock()
      q.payload = { data: [], count: 0 }
      calls.push(q)
    }
    calls.forEach((q) => mockAdmin.from.mockReturnValueOnce(q))

    await inbox.getMyInbox('u-1')

    // The overdue query filters both `not(is null)` AND lt(now): undated rows
    // are excluded by the not(is) leg, not by the < comparison.
    const overdue = calls[2]!
    expect(overdue.ops.some((o) => o.op === 'not')).toBe(true)
    expect(overdue.ops.some((o) => o.op === 'lt')).toBe(true)
  })

  it('unread is filtered to open conversations with unread > 0', async () => {
    const calls: QueryMock[] = []
    for (let i = 0; i < 4; i++) {
      const q = new QueryMock()
      q.payload = { data: [], count: 0 }
      calls.push(q)
    }
    calls.forEach((q) => mockAdmin.from.mockReturnValueOnce(q))

    await inbox.getMyInbox('u-1')

    const unread = calls[3]!
    expect(unread.ops.find((o) => o.op === 'gt')?.args).toEqual(['unread_count', 0])
    expect(unread.ops.find((o) => o.op === 'eq')?.args).toEqual(['status', 'open'])
  })

  it('flattens embedded contact FK selects from array to single', async () => {
    queueBuckets([
      { data: [makeTicket({ name: 'Reembolso', contacts: [{ name: 'Luis' }] })], count: 1 },
      { data: [], count: 0 },
      { data: [], count: 0 },
      { data: [], count: 0 },
    ])

    const out = await inbox.getMyInbox('u-1')
    expect(out.mine.rows[0]?.contact_name).toBe('Luis')
    expect(out.mine.rows[0]?.name).toBe('Reembolso')
  })

  it('an empty array on the to-one FK still serialises as null contact', async () => {
    queueBuckets([
      { data: [makeTicket({ contacts: [] })], count: 1 },
      { data: [], count: 0 },
      { data: [], count: 0 },
      { data: [], count: 0 },
    ])

    const out = await inbox.getMyInbox('u-1')
    expect(out.mine.rows[0]?.contact_name).toBeNull()
  })
})
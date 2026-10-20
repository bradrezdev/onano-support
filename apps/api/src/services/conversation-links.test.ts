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
  upsert(rows: unknown, opts: unknown) { return this.record('upsert', [rows, opts]) }
  maybeSingle(): Promise<Response> { return Promise.resolve(this.payload) }
  single(): Promise<Response> {
    const d = Array.isArray(this.payload.data) ? this.payload.data[0] : this.payload.data
    return Promise.resolve({ ...this.payload, data: d })
  }
  delete(): QueryMock { return this }
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

const links = await import('./conversation-links')

beforeEach(() => {
  mockAdmin.from.mockReset()
})

// listLinkedTickets uses single from() query with embedded tickets select.
function setNextFrom(payload: Response) {
  const q = new QueryMock()
  q.payload = payload
  mockAdmin.from.mockReturnValueOnce(q)
}

describe('listLinkedTickets', () => {
  it('queries conversation_tickets with both conversation_id filter and embedded tickets select', async () => {
    setNextFrom({
      data: [
        {
          ticket_id: 't-1',
          tickets: [{ id: 't-1', name: 'Login roto', status: 'open', assigned_to: 'u-1', updated_at: '2026-01-01' }],
        },
      ],
      error: null,
    })
    const out = await links.listLinkedTickets('c-1')
    expect(out.length).toBe(1)
    expect(out[0]!.id).toBe('t-1')
    expect(out[0]!.name).toBe('Login roto')
    expect(mockAdmin.from).toHaveBeenCalledWith('conversation_tickets')
    const q = mockAdmin.from.mock.results[0]!.value as QueryMock
    const eqCall = q.ops.find((o) => o.op === 'eq')
    expect(eqCall!.args).toEqual(['conversation_id', 'c-1'])
  })

  it('flattens Supabase embedded selects (tickets is an array, take [0])', async () => {
    setNextFrom({
      data: [
        { ticket_id: 't-1', tickets: [{ id: 't-1', name: 'a', status: 'open', assigned_to: null, updated_at: 'x' }] },
        { ticket_id: 't-2', tickets: [] }, // empty array — must skip
        { ticket_id: 't-3', tickets: [{ id: 't-3', name: 'b', status: 'closed', assigned_to: null, updated_at: 'y' }] },
      ],
      error: null,
    })
    const out = await links.listLinkedTickets('c-1')
    expect(out.length).toBe(2)
    expect(out.map((t) => t.id)).toEqual(['t-1', 't-3'])
  })

  it('skips rows with null embedded select', async () => {
    setNextFrom({ data: [{ ticket_id: 't-x', tickets: null }], error: null })
    const out = await links.listLinkedTickets('c-1')
    expect(out).toEqual([])
  })

  it('returns [] when no rows are linked', async () => {
    setNextFrom({ data: [], error: null })
    const out = await links.listLinkedTickets('c-1')
    expect(out).toEqual([])
  })

  it('throws when Supabase returns an error', async () => {
    setNextFrom({ data: null, error: { message: 'permission denied' } })
    await expect(links.listLinkedTickets('c-1')).rejects.toBeDefined()
  })
})

describe('listLinkedConversations', () => {
  it('queries with ticket_id filter and flattens conversations embedded select', async () => {
    setNextFrom({
      data: [
        {
          conversation_id: 'c-1',
          conversations: [{ id: 'c-1', contact_id: 'co-1', status: 'open', last_message_at: '2026-01-01', last_message_preview: 'hi' }],
        },
      ],
      error: null,
    })
    const out = await links.listLinkedConversations('t-1')
    expect(out.length).toBe(1)
    expect(out[0]!.last_message_preview).toBe('hi')
    const q = mockAdmin.from.mock.results[0]!.value as QueryMock
    const eqCall = q.ops.find((o) => o.op === 'eq')
    expect(eqCall!.args).toEqual(['ticket_id', 't-1'])
  })
})

describe('linkTicketToConversation', () => {
  it('throws ticket_not_found 404 when ticket is missing', async () => {
    // Promise.all -> tickets query (maybeSingle returns null) and conversations query (mockSingle ok).
    const tQ = new QueryMock()
    tQ.payload = { data: null, error: null }
    const cQ = new QueryMock()
    cQ.payload = { data: { id: 'c-1' }, error: null }
    mockAdmin.from.mockReturnValueOnce(tQ).mockReturnValueOnce(cQ)

    await expect(links.linkTicketToConversation('c-1', 't-1', 'u-1')).rejects.toMatchObject({
      code: 'ticket_not_found',
      status: 404,
    })
  })

  it('throws conversation_not_found 404 when conversation is missing', async () => {
    const tQ = new QueryMock()
    tQ.payload = { data: { id: 't-1' }, error: null }
    const cQ = new QueryMock()
    cQ.payload = { data: null, error: null }
    mockAdmin.from.mockReturnValueOnce(tQ).mockReturnValueOnce(cQ)

    await expect(links.linkTicketToConversation('c-1', 't-1', 'u-1')).rejects.toMatchObject({
      code: 'conversation_not_found',
      status: 404,
    })
  })

  it('upserts on composite PK (conversation_id, ticket_id) and is idempotent', async () => {
    // Pre-checks: ticket + conversation exist (parallel)
    const tQ = new QueryMock()
    tQ.payload = { data: { id: 't-1' }, error: null }
    const cQ = new QueryMock()
    cQ.payload = { data: { id: 'c-1' }, error: null }
    mockAdmin.from.mockReturnValueOnce(tQ).mockReturnValueOnce(cQ)
    // Upsert result
    const uQ = new QueryMock()
    uQ.payload = {
      data: { conversation_id: 'c-1', ticket_id: 't-1', linked_by: 'u-1', linked_at: '2026-01-01' },
      error: null,
    }
    mockAdmin.from.mockReturnValueOnce(uQ)

    const out = await links.linkTicketToConversation('c-1', 't-1', 'u-1')
    expect(out.ticket_id).toBe('t-1')
    const upsertCall = uQ.ops.find((o) => o.op === 'upsert')
    expect(upsertCall).toBeDefined()
    const [rows, opts] = upsertCall!.args as [Record<string, unknown>, { onConflict: string }]
    expect(rows).toEqual({ conversation_id: 'c-1', ticket_id: 't-1', linked_by: 'u-1' })
    expect(opts).toEqual({ onConflict: 'conversation_id,ticket_id' })
  })

  it('rejects when both pre-checks indicate missing resources, returning first error', async () => {
    const tQ = new QueryMock()
    tQ.payload = { data: null, error: null }
    const cQ = new QueryMock()
    cQ.payload = { data: null, error: null }
    mockAdmin.from.mockReturnValueOnce(tQ).mockReturnValueOnce(cQ)
    await expect(links.linkTicketToConversation('c-1', 't-1', 'u-1')).rejects.toMatchObject({
      code: 'ticket_not_found',
    })
  })
})

describe('unlinkTicketFromConversation', () => {
  it('returns {removed: false} when nothing matches', async () => {
    const q = new QueryMock()
    q.payload = { data: [], error: null }
    mockAdmin.from.mockReturnValueOnce(q)
    const out = await links.unlinkTicketFromConversation('c-1', 't-1')
    expect(out).toEqual({ removed: false })
    const eqs = q.ops.filter((o) => o.op === 'eq').map((o) => o.args)
    expect(eqs.length).toBe(2)
  })

  it('returns {removed: true} when a row was deleted', async () => {
    const q = new QueryMock()
    q.payload = { data: [{ conversation_id: 'c-1' }], error: null }
    mockAdmin.from.mockReturnValueOnce(q)
    const out = await links.unlinkTicketFromConversation('c-1', 't-1')
    expect(out).toEqual({ removed: true })
  })

  it('throws when Supabase returns an error', async () => {
    const q = new QueryMock()
    q.payload = { data: null, error: { message: 'rls denied' } }
    mockAdmin.from.mockReturnValueOnce(q)
    await expect(links.unlinkTicketFromConversation('c-1', 't-1')).rejects.toBeDefined()
  })
})

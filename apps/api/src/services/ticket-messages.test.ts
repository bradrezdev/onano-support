import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Supabase query mock. Plain class with chainable operators, an inspectable
// `.ops` array, a settable `.payload`, and thenable resolution so callers can
// `await admin.from('x').select(...).eq(...).order(...)` and read the payload.
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

  // chainable operators
  select(...args: unknown[]) { return this.record('select', args) }
  eq(col: string, val: unknown) { return this.record('eq', [col, val]) }
  order(col: string, opts?: unknown) { return this.record('order', [col, opts]) }
  limit(n: number) { return this.record('limit', [n]) }
  insert(rows: unknown) { return this.record('insert', [rows]) }
  upsert(rows: unknown, opts: unknown) { return this.record('upsert', [rows, opts]) }

  // terminals
  maybeSingle(): Promise<Response> {
    return Promise.resolve(this.payload)
  }
  single(): Promise<Response> {
    const d = Array.isArray(this.payload.data) ? this.payload.data[0] : this.payload.data
    return Promise.resolve({ ...this.payload, data: d })
  }

  // thenable — resolves to the payload for `await from(...).select(...)` without
  // an explicit terminal call.
  then<T>(
    onFulfilled: (v: Response) => T,
  ): Promise<T> {
    return Promise.resolve(this.payload).then(onFulfilled)
  }
}

const mockAdmin = {
  from: vi.fn((): QueryMock => new QueryMock()),
}

vi.mock('@/lib/supabase/admin', () => ({
  createSupabaseAdminClient: () => mockAdmin,
}))

// Import AFTER mocking.
const ticketMessages = await import('./ticket-messages')

beforeEach(() => {
  mockAdmin.from.mockReset()
})

// ---------------------------------------------------------------------------
// listTicketMessages
// ---------------------------------------------------------------------------

describe('listTicketMessages', () => {
  it('queries ticket_messages ordered by created_at asc', async () => {
    mockAdmin.from.mockReturnValueOnce(
      makePromise({ data: [{ id: 'm1', ticket_id: 't1', author_id: 'u1', body: null, body_plain: 'hi', role_at_send: 'admin', fade_step: 0, created_at: '2026-01-01T00:00:00Z' }] }),
    )
    const out = await ticketMessages.listTicketMessages('t1')
    expect(mockAdmin.from).toHaveBeenCalledWith('ticket_messages')
    expect(out.length).toBe(1)
    expect(out[0]!.id).toBe('m1')
    const q = mockAdmin.from.mock.results[0]!.value as QueryMock
    const orderCall = q.ops.find((o) => o.op === 'order')
    expect(orderCall?.args).toEqual(['created_at', { ascending: true }])
  })

  it('returns [] when data is null', async () => {
    mockAdmin.from.mockReturnValueOnce(makePromise({ data: null }))
    const messages = await ticketMessages.listTicketMessages('t1')
    expect(messages).toEqual([])
  })

  it('throws when Supabase returns an error', async () => {
    mockAdmin.from.mockReturnValueOnce(makePromise({ data: null, error: { message: 'boom' } }))
    await expect(ticketMessages.listTicketMessages('t1')).rejects.toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// createTicketMessage — fade_step and ticket state
// ---------------------------------------------------------------------------

describe('createTicketMessage', () => {
  it('sanitizes the body, sets fade_step = 0 when no prior message exists for role', async () => {
    mockAdmin.from
      .mockReturnValueOnce(makeTickets('open'))
      .mockReturnValueOnce(makeLastFade([]))
      .mockReturnValueOnce(makeInsertResult({ fade_step: 0 }))

    const out = await ticketMessages.createTicketMessage(
      't1',
      { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hello' }] }] },
      'u1',
      'admin',
    )
    expect(out.fade_step).toBe(0)
    expect(out.role_at_send).toBe('admin')
    // Insert sanitizes only allowed nodes — image becomes empty doc.
    const insertCall = (mockAdmin.from.mock.results[2]!.value as QueryMock).ops.find((o) => o.op === 'insert')
    expect(insertCall).toBeDefined()
    const insertedRow = (insertCall!.args[0] as Record<string, unknown>)
    expect(insertedRow.body_plain).toBe('hello')
    expect(insertedRow.ticket_id).toBe('t1')
    expect(insertedRow.author_id).toBe('u1')
    expect(insertedRow.role_at_send).toBe('admin')
  })

  it('increments fade_step based on last same-role message', async () => {
    mockAdmin.from
      .mockReturnValueOnce(makeTickets('open'))
      .mockReturnValueOnce(makeLastFade([{ fade_step: 4 }]))
      .mockReturnValueOnce(makeInsertResult({ fade_step: 5 }))

    const out = await ticketMessages.createTicketMessage(
      't1',
      { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hi' }] }] },
      'u1',
      'soporte',
    )
    expect(out.fade_step).toBe(5)
  })

  it('caps fade_step at 9 when last message was already 9', async () => {
    mockAdmin.from
      .mockReturnValueOnce(makeTickets('open'))
      .mockReturnValueOnce(makeLastFade([{ fade_step: 9 }]))
      .mockReturnValueOnce(makeInsertResult({ fade_step: 9 }))

    const out = await ticketMessages.createTicketMessage(
      't1',
      { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }] },
      'u1',
      'admin',
    )
    expect(out.fade_step).toBe(9)
  })

  it('throws empty_body when plain text is empty after sanitize', async () => {
    await expect(
      ticketMessages.createTicketMessage(
        't1',
        { type: 'doc', content: [{ type: 'image', attrs: { src: 'x' } }] },
        'u1',
        'admin',
      ),
    ).rejects.toMatchObject({ code: 'empty_body', status: 400 })
  })

  it('throws ticket_not_found when tickets query returns null', async () => {
    const ticketsQ = new QueryMock()
    ticketsQ.payload = { data: null, error: null }
    const lastQ = new QueryMock()
    lastQ.payload = { data: [], error: null }
    mockAdmin.from.mockReturnValueOnce(ticketsQ).mockReturnValueOnce(lastQ)
    await expect(
      ticketMessages.createTicketMessage(
        't1',
        { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hi' }] }] },
        'u1',
        'admin',
      ),
    ).rejects.toMatchObject({ code: 'ticket_not_found', status: 404 })
  })

  it('throws ticket_closed with status 409 when ticket is closed', async () => {
    const ticketsQ = makeTickets('closed')
    const lastQ = new QueryMock()
    lastQ.payload = { data: [], error: null }
    mockAdmin.from.mockReturnValueOnce(ticketsQ).mockReturnValueOnce(lastQ)
    await expect(
      ticketMessages.createTicketMessage(
        't1',
        { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hi' }] }] },
        'u1',
        'admin',
      ),
    ).rejects.toMatchObject({ code: 'ticket_closed', status: 409 })
  })
})

// ---------------------------------------------------------------------------
// listRoleColors
// ---------------------------------------------------------------------------

describe('listRoleColors', () => {
  it('returns role_color_settings ordered by role asc', async () => {
    mockAdmin.from.mockReturnValueOnce(
      makePromise({
        data: [
          { role: 'admin', base_color: '#ff0000', fade_steps: 10 },
          { role: 'supervisor', base_color: '#00ff00', fade_steps: 10 },
          { role: 'soporte', base_color: '#0000ff', fade_steps: 10 },
        ],
      }),
    )
    const out = await ticketMessages.listRoleColors()
    expect(out.length).toBe(3)
    const q = mockAdmin.from.mock.results[0]!.value as QueryMock
    const orderCall = q.ops.find((o) => o.op === 'order')
    expect(orderCall?.args).toEqual(['role', { ascending: true }])
  })
})

// ---------------------------------------------------------------------------
// upsertRoleColor
// ---------------------------------------------------------------------------

describe('upsertRoleColor', () => {
  it('rejects malformed hex codes', async () => {
    for (const bad of ['red', '#fff', '#GGGGGG', '##123456']) {
      await expect(
        ticketMessages.upsertRoleColor('admin', bad, 5, 'u1'),
      ).rejects.toMatchObject({ code: 'invalid_color' })
    }
    expect(mockAdmin.from).not.toHaveBeenCalled()
  })

  it('rejects fade_steps out of [1, 10] or non-integer', async () => {
    for (const bad of [0, 11, 1.5, -1]) {
      await expect(
        ticketMessages.upsertRoleColor('admin', '#ff0000', bad as number, 'u1'),
      ).rejects.toMatchObject({ code: 'invalid_fade_steps' })
    }
    expect(mockAdmin.from).not.toHaveBeenCalled()
  })

  it('upserts with onConflict role and returns the new setting', async () => {
    mockAdmin.from.mockReturnValueOnce(
      makePromise({ data: { role: 'admin', base_color: '#abcdef', fade_steps: 8 } }),
    )
    const out = await ticketMessages.upsertRoleColor('admin', '#ABCDEF', 8, 'u1')
    expect(out.role).toBe('admin')
    expect(out.fade_steps).toBe(8)
    const q = mockAdmin.from.mock.results[0]!.value as QueryMock
    const upsertCall = q.ops.find((o) => o.op === 'upsert')
    expect(upsertCall).toBeDefined()
    const [rows, opts] = upsertCall!.args as [Record<string, unknown>, { onConflict: string }]
    expect(rows).toMatchObject({ role: 'admin', base_color: '#ABCDEF', fade_steps: 8, updated_by: 'u1' })
    expect(opts).toEqual({ onConflict: 'role' })
  })
})

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function makePromise(payload: Response): QueryMock {
  const q = new QueryMock()
  q.payload = payload
  return q
}

function makeTickets(status: 'open' | 'in_progress' | 'closed'): QueryMock {
  return makePromise({ data: { id: 't1', status }, error: null })
}

function makeLastFade(rows: { fade_step: number }[]): QueryMock {
  return makePromise({ data: rows, error: null })
}

function makeInsertResult(overrides: Partial<{ fade_step: number }> = {}): QueryMock {
  return makePromise({
    data: {
      id: 'm-x',
      ticket_id: 't1',
      author_id: 'u1',
      body: {},
      body_plain: 'x',
      role_at_send: 'admin',
      fade_step: 0,
      created_at: '2026-01-01T00:00:00Z',
      ...overrides,
    },
    error: null,
  })
}

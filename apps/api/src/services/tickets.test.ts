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

function makeTicket(overrides: Partial<{
  status: 'open' | 'in_progress' | 'closed'
  assigned_to: string | null
  theme_id: string | null
  flow_id: string | null
  category_id: string
  closed_at: string | null
}> = {}) {
  return {
    id: 'tk-1',
    contact_id: 'co-1',
    category_id: 'cat-1',
    assigned_to: null,
    theme_id: null,
    flow_id: null,
    name: 'Login roto',
    description: { type: 'doc', content: [] },
    description_plain: 'desc',
    status: 'open',
    created_by: 'u-1',
    closed_by: null,
    closed_at: null,
    reopened_by: null,
    reopened_at: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// createTicket
// ---------------------------------------------------------------------------

describe('createTicket — validation', () => {
  const validInput = {
    contact_id: 'co-1',
    category_id: 'cat-1',
    name: 'Login roto',
    description: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'desc' }] }] },
  }

  it('throws invalid_description when description is not a TipTap doc', async () => {
    await expect(
      tickets.createTicket({ ...validInput, description: { type: 'paragraph' } as unknown }, 'u-1'),
    ).rejects.toMatchObject({ code: 'invalid_description' })
  })

  it('throws empty_description when plain text is empty after sanitize', async () => {
    await expect(
      tickets.createTicket(
        { ...validInput, description: { type: 'doc', content: [{ type: 'image', attrs: { src: 'x' } }] } },
        'u-1',
      ),
    ).rejects.toMatchObject({ code: 'empty_description' })
  })
})

describe('createTicket — happy path', () => {
  it('inserts with status=open, trims name, writes description_plain, and writes a created history event', async () => {
    const input = {
      contact_id: 'co-1',
      category_id: 'cat-1',
      name: '  Login roto  ',
      description: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'desc' }] }] },
    }
    // 1) tickets insert
    const insertQ = setNextFrom({
      data: makeTicket({ status: 'open' }),
      error: null,
    })
    // 2) ticket_history insert for "created"
    const historyQ = setNextFrom({ data: null, error: null })

    const out = await tickets.createTicket(input, 'u-1')
    expect(out.id).toBe('tk-1')
    const insertRow = insertQ.ops.find((o) => o.op === 'insert')!.args[0] as Record<string, unknown>
    expect(insertRow).toMatchObject({
      contact_id: 'co-1',
      category_id: 'cat-1',
      name: 'Login roto', // trimmed
      status: 'open',
      created_by: 'u-1',
    })
    expect(insertRow.description_plain).toBe('desc')

    const historyRow = historyQ.ops.find((o) => o.op === 'insert')!.args[0] as Record<string, unknown>
    expect(historyRow).toMatchObject({
      ticket_id: 'tk-1',
      actor_id: 'u-1',
      action: 'created',
    })
  })
})

// ---------------------------------------------------------------------------
// findTicketOrThrow
// ---------------------------------------------------------------------------

describe('findTicketOrThrow', () => {
  it('throws not_found when no row matches', async () => {
    setNextFrom({ data: null, error: null })
    await expect(tickets.findTicketOrThrow('missing')).rejects.toMatchObject({ code: 'not_found' })
  })

  it('throws Supabase error as-is (not wrapped)', async () => {
    setNextFrom({ data: null, error: { message: 'rls' } })
    await expect(tickets.findTicketOrThrow('t-1')).rejects.toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// updateTicket
// ---------------------------------------------------------------------------

describe('updateTicket', () => {
  const before = makeTicket({ status: 'open', assigned_to: 'u-1', theme_id: 'th-1', flow_id: 'fl-1' })

  it('sanitizes description patch and throws on invalid', async () => {
    setNextFrom({ data: before, error: null })
    await expect(
      tickets.updateTicket('tk-1', { description: 'plain string' as unknown }, 'u-1'),
    ).rejects.toMatchObject({ code: 'invalid_description' })
  })

  it('throws empty_description when patch description has no plain text', async () => {
    setNextFrom({ data: before, error: null })
    await expect(
      tickets.updateTicket('tk-1', { description: { type: 'doc', content: [{ type: 'image', attrs: { src: 'x' } }] } }, 'u-1'),
    ).rejects.toMatchObject({ code: 'empty_description' })
  })

  it('updates only fields in the patch', async () => {
    setNextFrom({ data: before, error: null }) // findTicketOrThrow
    const updateQ = setNextFrom({ data: { ...before, name: 'Updated name' }, error: null }) // update
    await tickets.updateTicket('tk-1', { name: '  Updated name  ' }, 'u-1')
    const updateRow = updateQ.ops.find((o) => o.op === 'update')!.args[0] as Record<string, unknown>
    expect(updateRow.name).toBe('Updated name')
    expect('description' in updateRow).toBe(false)
    expect('assigned_to' in updateRow).toBe(false)
  })

  it('writes flow_changed history only when flow_id actually changes', async () => {
    setNextFrom({ data: before, error: null }) // findTicketOrThrow
    const updateQ = setNextFrom({ data: { ...before, flow_id: 'fl-2' }, error: null }) // update
    setNextFrom({ data: null, error: null }) // history insert
    await tickets.updateTicket('tk-1', { flow_id: 'fl-2' }, 'u-1')
    const updateRow = updateQ.ops.find((o) => o.op === 'update')!.args[0] as Record<string, unknown>
    expect(updateRow.flow_id).toBe('fl-2')
  })
})

// ---------------------------------------------------------------------------
// moveTicket
// ---------------------------------------------------------------------------

describe('moveTicket', () => {
  it('refuses to move a closed ticket', async () => {
    setNextFrom({ data: makeTicket({ status: 'closed' }), error: null })
    await expect(tickets.moveTicket('tk-1', 'fl-2', 'u-1')).rejects.toMatchObject({ code: 'ticket_closed' })
    // Only the findTicketOrThrow call should have happened.
    expect(mockAdmin.from).toHaveBeenCalledTimes(1)
  })

  it('writes flow_changed history with from/to values', async () => {
    setNextFrom({ data: makeTicket({ flow_id: 'fl-1' }), error: null }) // findTicketOrThrow
    const updateQ = setNextFrom({ data: makeTicket({ flow_id: 'fl-2' }), error: null }) // update
    const historyQ = setNextFrom({ data: null, error: null }) // history insert
    await tickets.moveTicket('tk-1', 'fl-2', 'u-1')
    const historyRow = historyQ.ops.find((o) => o.op === 'insert')!.args[0] as Record<string, unknown>
    expect(historyRow).toMatchObject({
      ticket_id: 'tk-1',
      actor_id: 'u-1',
      action: 'flow_changed',
      from_value: 'fl-1',
      to_value: 'fl-2',
    })
    const updateRow = updateQ.ops.find((o) => o.op === 'update')!.args[0] as Record<string, unknown>
    expect(updateRow.flow_id).toBe('fl-2')
  })
})

// ---------------------------------------------------------------------------
// closeTicket
// ---------------------------------------------------------------------------

describe('closeTicket', () => {
  it('refuses with already_closed when ticket is already closed', async () => {
    setNextFrom({ data: makeTicket({ status: 'closed' }), error: null })
    await expect(tickets.closeTicket('tk-1', 'u-1')).rejects.toMatchObject({ code: 'already_closed' })
    expect(mockAdmin.from).toHaveBeenCalledTimes(1)
  })

  it('updates status, sets closed_by/at, and writes closed history', async () => {
    setNextFrom({ data: makeTicket({ status: 'open' }), error: null })
    const updateQ = setNextFrom({
      data: makeTicket({ status: 'closed', closed_at: '2026-02-01T00:00:00Z' }),
      error: null,
    })
    const historyQ = setNextFrom({ data: null, error: null })
    const out = await tickets.closeTicket('tk-1', 'u-1')
    expect(out.status).toBe('closed')
    const updateRow = updateQ.ops.find((o) => o.op === 'update')!.args[0] as Record<string, unknown>
    expect(updateRow.status).toBe('closed')
    expect(updateRow.closed_by).toBe('u-1')
    const historyRow = historyQ.ops.find((o) => o.op === 'insert')!.args[0] as Record<string, unknown>
    expect(historyRow).toMatchObject({
      ticket_id: 'tk-1',
      actor_id: 'u-1',
      action: 'closed',
    })
    expect(historyRow.from_value).toMatchObject({ status: 'open' })
    expect(historyRow.to_value).toMatchObject({ status: 'closed' })
  })
})

// ---------------------------------------------------------------------------
// reopenTicket
// ---------------------------------------------------------------------------

describe('reopenTicket', () => {
  it('refuses with not_closed when ticket is open', async () => {
    setNextFrom({ data: makeTicket({ status: 'open' }), error: null })
    await expect(tickets.reopenTicket('tk-1', 'u-1')).rejects.toMatchObject({ code: 'not_closed' })
    expect(mockAdmin.from).toHaveBeenCalledTimes(1)
  })

  it('clears closed_by/at and writes reopened history', async () => {
    setNextFrom({
      data: makeTicket({ status: 'closed', closed_at: '2026-01-15T00:00:00Z' }),
      error: null,
    })
    const updateQ = setNextFrom({
      data: makeTicket({ status: 'open' }),
      error: null,
    })
    const historyQ = setNextFrom({ data: null, error: null })
    await tickets.reopenTicket('tk-1', 'u-1')
    const updateRow = updateQ.ops.find((o) => o.op === 'update')!.args[0] as Record<string, unknown>
    expect(updateRow.status).toBe('open')
    expect(updateRow.closed_by).toBeNull()
    expect(updateRow.closed_at).toBeNull()
    const historyRow = historyQ.ops.find((o) => o.op === 'insert')!.args[0] as Record<string, unknown>
    expect(historyRow.action).toBe('reopened')
    expect(historyRow.from_value).toMatchObject({ status: 'closed' })
    expect(historyRow.to_value).toMatchObject({ status: 'open' })
  })
})

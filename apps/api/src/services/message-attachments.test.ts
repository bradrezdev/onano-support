import { describe, it, expect, vi, beforeEach } from 'vitest'

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
  in(col: string, vals: unknown[]) { return this.record('in', [col, vals]) }
  upsert(rows: unknown, opts?: unknown) { return this.record('upsert', [rows, opts]) }
  insert(rows: unknown) { return this.record('insert', [rows]) }
  update(rows: unknown) { return this.record('update', [rows]) }
  delete() { return this.record('delete', []) }
  order(...args: unknown[]) { return this.record('order', args) }
  limit(n: number) { return this.record('limit', [n]) }
  maybeSingle(): Promise<Response> { return Promise.resolve(this.payload) }
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

const attachments = await import('./message-attachments')

beforeEach(() => {
  mockAdmin.from.mockReset()
})

function setNextFrom(payload: Response): QueryMock {
  const q = new QueryMock()
  q.payload = payload
  mockAdmin.from.mockReturnValueOnce(q)
  return q
}

function makeMessage(over: Record<string, unknown> = {}) {
  return {
    id: 'msg-1',
    body: 'Hola, no me llega el pago',
    direction: 'in',
    created_at: '2026-01-01',
    ...over,
  }
}

// ---------------------------------------------------------------------------
// listAttachableMessages — the picker only offers actionable choices
// ---------------------------------------------------------------------------

describe('listAttachableMessages', () => {
  it('filters out messages already attached to the ticket', async () => {
    setNextFrom({ data: [{ message_id: 'msg-2' }], error: null }) // already attached
    setNextFrom({
      data: [makeMessage({ id: 'msg-1' }), makeMessage({ id: 'msg-2' })],
      error: null,
    })

    const out = await attachments.listAttachableMessages('cv-1', 'tk-1')

    expect(out.map((m) => m.id)).toEqual(['msg-1'])
  })

  it('offers every message when nothing is attached yet', async () => {
    setNextFrom({ data: [], error: null })
    setNextFrom({ data: [makeMessage({ id: 'msg-1' })], error: null })

    const out = await attachments.listAttachableMessages('cv-1', 'tk-1')
    expect(out).toHaveLength(1)
  })

  it('scopes to the conversation, not the whole messages table', async () => {
    setNextFrom({ data: [], error: null })
    const msgQ = setNextFrom({ data: [], error: null })

    await attachments.listAttachableMessages('cv-77', 'tk-1')

    expect(msgQ.ops.find((o) => o.op === 'eq')?.args).toEqual(['conversation_id', 'cv-77'])
  })
})

// ---------------------------------------------------------------------------
// attachMessages — the guards that stop evidence leaking
// ---------------------------------------------------------------------------

describe('attachMessages', () => {
  it('returns zero for an empty selection without touching the DB', async () => {
    const out = await attachments.attachMessages('tk-1', [], 'u-1')
    expect(out).toEqual({ attached: 0, skipped: 0 })
    expect(mockAdmin.from).not.toHaveBeenCalled()
  })

  it('refuses to attach to a ticket that does not exist', async () => {
    setNextFrom({ data: null, error: null }) // ticket lookup
    await expect(
      attachments.attachMessages('tk-ghost', ['msg-1'], 'u-1'),
    ).rejects.toMatchObject({ code: 'ticket_not_found', status: 404 })
  })

  it('refuses to attach to a trashed ticket', async () => {
    // The lookup filters deleted_at is null, so a trashed ticket yields no row.
    const q = setNextFrom({ data: null, error: null })
    await expect(
      attachments.attachMessages('tk-1', ['msg-1'], 'u-1'),
    ).rejects.toMatchObject({ code: 'ticket_not_found' })
    expect(q.ops.some((o) => o.op === 'is' && o.args[0] === 'deleted_at')).toBe(true)
  })

  it('rejects message ids that do not exist', async () => {
    setNextFrom({ data: { id: 'tk-1' }, error: null }) // ticket exists
    setNextFrom({ data: [{ id: 'msg-1' }], error: null }) // only msg-1 exists

    await expect(
      attachments.attachMessages('tk-1', ['msg-1', 'msg-99'], 'u-1'),
    ).rejects.toMatchObject({ code: 'message_not_found' })
  })

  it('writes one row per message with the actor recorded', async () => {
    setNextFrom({ data: { id: 'tk-1' }, error: null })
    setNextFrom({ data: [{ id: 'msg-1' }, { id: 'msg-2' }], error: null })
    const upQ = setNextFrom({ data: null, error: null })

    const out = await attachments.attachMessages('tk-1', ['msg-1', 'msg-2'], 'u-9')

    const rows = upQ.ops.find((o) => o.op === 'upsert')?.args[0] as Array<Record<string, unknown>>
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({
      ticket_id: 'tk-1',
      message_id: 'msg-1',
      attached_by: 'u-9',
    })
    expect(out).toEqual({ attached: 2, skipped: 0 })
  })

  it('is idempotent: re-attaching the same message is a no-op upsert', async () => {
    setNextFrom({ data: { id: 'tk-1' }, error: null })
    setNextFrom({ data: [{ id: 'msg-1' }], error: null })
    const upQ = setNextFrom({ data: null, error: null })

    await attachments.attachMessages('tk-1', ['msg-1'], 'u-9')

    const opts = upQ.ops.find((o) => o.op === 'upsert')?.args[1] as
      | { onConflict: string; ignoreDuplicates: boolean }
      | undefined
    expect(opts?.onConflict).toBe('ticket_id,message_id')
    expect(opts?.ignoreDuplicates).toBe(true)
  })

  it('stores the optional note', async () => {
    setNextFrom({ data: { id: 'tk-1' }, error: null })
    setNextFrom({ data: [{ id: 'msg-1' }], error: null })
    const upQ = setNextFrom({ data: null, error: null })

    await attachments.attachMessages('tk-1', ['msg-1'], 'u-9', 'el que prueba el retraso')

    const rows = upQ.ops.find((o) => o.op === 'upsert')?.args[0] as Array<Record<string, unknown>>
    expect(rows[0]!.note).toBe('el que prueba el retraso')
  })
})

// ---------------------------------------------------------------------------
// listTicketAttachments / detachMessage
// ---------------------------------------------------------------------------

describe('listTicketAttachments', () => {
  it('flattens the embedded message FK', async () => {
    setNextFrom({
      data: [
        {
          ticket_id: 'tk-1',
          message_id: 'msg-1',
          attached_by: 'u-9',
          attached_at: '2026-01-02',
          note: null,
          messages: { body: 'hola', direction: 'in', created_at: '2026-01-01' },
        },
      ],
      error: null,
    })

    const out = await attachments.listTicketAttachments('tk-1')

    expect(out[0]).toMatchObject({
      message_id: 'msg-1',
      body: 'hola',
      direction: 'in',
      attached_by: 'u-9',
    })
  })

  it('survives a missing embedded message instead of throwing', async () => {
    setNextFrom({
      data: [
        {
          ticket_id: 'tk-1',
          message_id: 'msg-1',
          attached_by: null,
          attached_at: '2026-01-02',
          note: null,
          messages: null,
        },
      ],
      error: null,
    })

    const out = await attachments.listTicketAttachments('tk-1')
    expect(out[0]?.body).toBeNull()
    expect(out[0]?.direction).toBe('in')
  })
})

describe('detachMessage', () => {
  it('deletes the attachment row scoped to the ticket', async () => {
    const q = setNextFrom({ data: null, error: null })
    await expect(attachments.detachMessage('tk-1', 'msg-1')).resolves.toEqual({
      detached: true,
    })
    const eqs = q.ops.filter((o) => o.op === 'eq').map((o) => o.args)
    expect(eqs).toContainEqual(['ticket_id', 'tk-1'])
    expect(eqs).toContainEqual(['message_id', 'msg-1'])
  })
})
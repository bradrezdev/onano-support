import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Supabase query mock (mirrors tickets.test.ts).
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
  in(col: string, vals: unknown[]) { return this.record('in', [col, vals]) }
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

const conversations = await import('./conversations')

beforeEach(() => {
  mockAdmin.from.mockReset()
})

function setNextFrom(payload: Response): QueryMock {
  const q = new QueryMock()
  q.payload = payload
  mockAdmin.from.mockReturnValueOnce(q)
  return q
}

// ---------------------------------------------------------------------------
// W2 — canAccessConversation
// ---------------------------------------------------------------------------

describe('canAccessConversation (W2)', () => {
  const admin = { id: 'admin-1', role: 'admin' as const }
  const supervisor = { id: 'sup-1', role: 'supervisor' as const }
  const soporte = { id: 'sop-1', role: 'soporte' as const }

  it('admin reads any conversation, assigned or not', () => {
    expect(conversations.canAccessConversation(admin, { assigned_agent_id: null })).toBe(true)
    expect(conversations.canAccessConversation(admin, { assigned_agent_id: 'sop-9' })).toBe(true)
  })

  it('supervisor reads any conversation, assigned or not', () => {
    expect(conversations.canAccessConversation(supervisor, { assigned_agent_id: null })).toBe(true)
    expect(conversations.canAccessConversation(supervisor, { assigned_agent_id: 'sop-9' })).toBe(true)
  })

  it('soporte reads their own conversation', () => {
    expect(conversations.canAccessConversation(soporte, { assigned_agent_id: 'sop-1' })).toBe(true)
  })

  it('soporte reads the unassigned queue so they can claim one', () => {
    expect(conversations.canAccessConversation(soporte, { assigned_agent_id: null })).toBe(true)
  })

  it("soporte cannot read somebody else's conversation", () => {
    expect(conversations.canAccessConversation(soporte, { assigned_agent_id: 'sop-9' })).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// listConversations — scoping
// ---------------------------------------------------------------------------

describe('listConversations', () => {
  it('scopes soporte to their own when include_unassigned is false', async () => {
    const q = setNextFrom({ data: [], error: null })
    await conversations.listConversations({ assigned_agent_id: 'sop-1' })
    const eq = q.ops.find((o) => o.op === 'eq')
    expect(eq?.args[0]).toBe('assigned_agent_id')
    expect(eq?.args[1]).toBe('sop-1')
  })

  it('includes the unassigned queue when include_unassigned is true', async () => {
    const q = setNextFrom({ data: [], error: null })
    await conversations.listConversations({
      assigned_agent_id: 'sop-1',
      include_unassigned: true,
    })
    const inOp = q.ops.find((o) => o.op === 'in')
    expect(inOp?.args[0]).toBe('assigned_agent_id')
    expect(inOp?.args[1]).toEqual(['sop-1', null])
  })
})

// ---------------------------------------------------------------------------
// reassignConversation (W4)
// ---------------------------------------------------------------------------

describe('reassignConversation (W4)', () => {
  it('refuses an assignee that does not exist', async () => {
    setNextFrom({ data: null, error: null }) // profiles lookup
    await expect(
      conversations.reassignConversation('cv-1', 'ghost', 'sup-1'),
    ).rejects.toMatchObject({ code: 'assignee_not_found', status: 400 })
  })

  it('refuses a suspended assignee', async () => {
    setNextFrom({
      data: { id: 'u-2', display_name: 'Ana', suspended_at: '2026-01-01', deleted_at: null },
      error: null,
    })
    await expect(
      conversations.reassignConversation('cv-1', 'u-2', 'sup-1'),
    ).rejects.toMatchObject({ code: 'assignee_inactive', status: 400 })
  })

  it('refuses a deleted assignee', async () => {
    setNextFrom({
      data: { id: 'u-3', display_name: 'Beto', suspended_at: null, deleted_at: '2026-01-01' },
      error: null,
    })
    await expect(
      conversations.reassignConversation('cv-1', 'u-3', 'sup-1'),
    ).rejects.toMatchObject({ code: 'assignee_inactive', status: 400 })
  })

  it('writes assigned_agent_id for an active assignee', async () => {
    setNextFrom({
      data: { id: 'u-1', display_name: 'Caro', suspended_at: null, deleted_at: null },
      error: null,
    })
    const updateQ = setNextFrom({
      data: {
        id: 'cv-1',
        contact_id: 'ct-1',
        assigned_agent_id: 'u-1',
        status: 'open',
        last_message_at: null,
        last_message_preview: null,
        unread_count: 0,
        created_at: '2026-01-01',
      },
      error: null,
    })

    const result = await conversations.reassignConversation('cv-1', 'u-1', 'sup-1')

    const upd = updateQ.ops.find((o) => o.op === 'update')
    expect(upd?.args[0]).toEqual({ assigned_agent_id: 'u-1' })
    expect(result.assigned_agent_id).toBe('u-1')
  })

  it('returns the conversation to the queue when assigned_agent_id is null', async () => {
    const updateQ = setNextFrom({
      data: {
        id: 'cv-1',
        contact_id: 'ct-1',
        assigned_agent_id: null,
        status: 'open',
        last_message_at: null,
        last_message_preview: null,
        unread_count: 0,
        created_at: '2026-01-01',
      },
      error: null,
    })

    const result = await conversations.reassignConversation('cv-1', null, 'sup-1')
    expect(updateQ.ops.find((o) => o.op === 'update')?.args[0]).toEqual({
      assigned_agent_id: null,
    })
    expect(result.assigned_agent_id).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// takeConversation (recommendation 7)
// ---------------------------------------------------------------------------

describe('takeConversation', () => {
  it('claims an unassigned conversation', async () => {
    const q = setNextFrom({
      data: {
        id: 'cv-1',
        contact_id: 'ct-1',
        assigned_agent_id: 'sop-1',
        status: 'open',
        last_message_at: null,
        last_message_preview: null,
        unread_count: 0,
        created_at: '2026-01-01',
      },
      error: null,
    })

    const result = await conversations.takeConversation('cv-1', 'sop-1')
    expect(q.ops.find((o) => o.op === 'update')?.args[0]).toEqual({
      assigned_agent_id: 'sop-1',
    })
    // The guard `.is('assigned_agent_id', null)` is what makes this atomic.
    expect(q.ops.some((o) => o.op === 'is' && o.args[0] === 'assigned_agent_id')).toBe(true)
    expect(result.assigned_agent_id).toBe('sop-1')
  })

  it('returns 409 when somebody else already claimed it', async () => {
    setNextFrom({ data: null, error: null }) // maybeSingle -> no row matched
    await expect(conversations.takeConversation('cv-1', 'sop-2')).rejects.toMatchObject({
      code: 'already_taken',
      status: 409,
    })
  })
})

// ---------------------------------------------------------------------------
// escalateConversation (W3)
// ---------------------------------------------------------------------------

describe('escalateConversation (W3)', () => {
  it('refuses an inactive target', async () => {
    setNextFrom({ data: { id: 'u-9', suspended_at: '2026-01-01', deleted_at: null }, error: null })
    await expect(
      conversations.escalateConversation('cv-1', 'u-9', 'sop-1'),
    ).rejects.toMatchObject({ code: 'assignee_inactive' })
  })

  it('records the ask without transferring ownership', async () => {
    setNextFrom({ data: { id: 'sup-1', suspended_at: null, deleted_at: null }, error: null })
    const updateQ = setNextFrom({
      data: {
        id: 'cv-1',
        contact_id: 'ct-1',
        assigned_agent_id: 'sop-1',
        status: 'open',
        last_message_at: null,
        last_message_preview: null,
        unread_count: 0,
        created_at: '2026-01-01',
      },
      error: null,
    })

    const { conversation, escalated_to } = await conversations.escalateConversation(
      'cv-1',
      'sup-1',
      'sop-1',
    )

    const written = updateQ.ops.find((o) => o.op === 'update')?.args[0] as Record<string, unknown>
    expect(written.escalated_to_id).toBe('sup-1')
    expect(written.escalated_by_id).toBe('sop-1')
    expect(written.escalated_at).toEqual(expect.any(String))
    // Ownership is untouched — an ask is not a handover.
    expect(written.assigned_agent_id).toBeUndefined()
    expect(conversation.assigned_agent_id).toBe('sop-1')
    expect(escalated_to).toBe('sup-1')
  })
})
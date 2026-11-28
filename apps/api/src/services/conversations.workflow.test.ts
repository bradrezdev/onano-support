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
  rpc: vi.fn(),
}

vi.mock('@/lib/supabase/admin', () => ({
  createSupabaseAdminClient: () => mockAdmin,
}))

const conversations = await import('./conversations')

beforeEach(() => {
  mockAdmin.from.mockReset()
  mockAdmin.rpc.mockReset()
})

function setNextRpc(payload: Response) {
  mockAdmin.rpc.mockReturnValueOnce(Promise.resolve(payload))
}

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
  it('sends the reason and the expected version to the database', async () => {
    setNextRpc({
      data: [
        {
          conversation_id: 'cv-1',
          contact_id: 'ct-1',
          assigned_agent_id: 'u-1',
          status: 'open',
          last_message_at: null,
          last_message_preview: null,
          unread_count: 0,
          created_at: '2026-01-01',
          assignment_version: 2,
          previous_assignee_id: 'u-0',
          changed_at: '2026-01-02',
        },
      ],
      error: null,
    })

    const result = await conversations.reassignConversation(
      'cv-1',
      'u-1',
      'sup-1',
      'el cliente pidió hablar con ventas',
      1,
    )

    const [fn, args] = mockAdmin.rpc.mock.calls[0]
    expect(fn).toBe('reassign_conversation')
    expect(args).toMatchObject({
      p_conversation_id: 'cv-1',
      p_actor_id: 'sup-1',
      p_new_assignee_id: 'u-1',
      p_reason: 'el cliente pidió hablar con ventas',
      p_expected_version: 1,
    })
    expect(result.assigned_agent_id).toBe('u-1')
    expect(result.assignment_version).toBe(2)
    // La fila completa viene de la función: nada de campos inventados.
    expect(result.id).toBe('cv-1')
    expect(result.contact_id).toBe('ct-1')
    expect(result.status).toBe('open')
    expect(result.unread_count).toBe(0)
    expect(result.created_at).toBe('2026-01-01')
  })

  it('maps a stale version to 409', async () => {
    setNextRpc({ data: null, error: { code: 'C0004', message: 'version_conflict' } })
    await expect(
      conversations.reassignConversation('cv-1', 'u-1', 'sup-1', 'motivo', 1),
    ).rejects.toMatchObject({ code: 'version_conflict', status: 409 })
  })

  it('maps an inactive assignee to 400', async () => {
    setNextRpc({ data: null, error: { code: 'C0005', message: 'invalid_assignee' } })
    await expect(
      conversations.reassignConversation('cv-1', 'ghost', 'sup-1', 'motivo', 1),
    ).rejects.toMatchObject({ code: 'invalid_assignee', status: 400 })
  })

  it('maps a missing reason to 400', async () => {
    setNextRpc({ data: null, error: { code: 'C0001', message: 'reason_required' } })
    await expect(
      conversations.reassignConversation('cv-1', 'u-1', 'sup-1', '   ', 1),
    ).rejects.toMatchObject({ code: 'reason_required', status: 400 })
  })

  it('returns the conversation to the queue when assigned_agent_id is null', async () => {
    setNextRpc({
      data: [
        {
          conversation_id: 'cv-1',
          contact_id: 'ct-1',
          assigned_agent_id: null,
          status: 'open',
          last_message_at: null,
          last_message_preview: null,
          unread_count: 0,
          created_at: '2026-01-01',
          assignment_version: 3,
          previous_assignee_id: 'u-1',
          changed_at: '2026-01-02',
        },
      ],
      error: null,
    })

    const result = await conversations.reassignConversation('cv-1', null, 'sup-1', 'vuelve a la cola', 2)
    expect(mockAdmin.rpc.mock.calls[0][1]).toMatchObject({ p_new_assignee_id: null })
    expect(result.assigned_agent_id).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// takeConversation (recommendation 7)
// ---------------------------------------------------------------------------

describe('takeConversation', () => {
  it('claims an unassigned conversation through the guarded function', async () => {
    setNextRpc({
      data: [
        {
          id: 'cv-1',
          contact_id: 'ct-1',
          assigned_agent_id: 'sop-1',
          status: 'open',
          last_message_at: null,
          last_message_preview: null,
          unread_count: 0,
          created_at: '2026-01-01',
          assignment_version: 2,
        },
      ],
      error: null,
    })

    const result = await conversations.takeConversation('cv-1', 'sop-1')
    const [fn, args] = mockAdmin.rpc.mock.calls[0]
    expect(fn).toBe('take_conversation')
    expect(args).toMatchObject({ p_conversation_id: 'cv-1', p_actor_id: 'sop-1' })
    expect(result.assigned_agent_id).toBe('sop-1')
    expect(result.assignment_version).toBe(2)
  })

  it('returns 409 when somebody else already claimed it', async () => {
    setNextRpc({ data: null, error: { code: 'C0010', message: 'already_taken' } })
    await expect(conversations.takeConversation('cv-1', 'sop-2')).rejects.toMatchObject({
      code: 'already_taken',
      status: 409,
    })
  })

  it('returns 404 when the conversation does not exist (not "already taken")', async () => {
    setNextRpc({ data: null, error: { code: 'C0003', message: 'conversation_not_found' } })
    await expect(conversations.takeConversation('cv-ghost', 'sop-2')).rejects.toMatchObject({
      code: 'conversation_not_found',
      status: 404,
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
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
  order(col: string, opts?: unknown) { return this.record('order', [col, opts]) }
  limit(n: number) { return this.record('limit', [n]) }
  insert(rows: unknown) { return this.record('insert', [rows]) }
  upsert(rows: unknown, opts: unknown) { return this.record('upsert', [rows, opts]) }
  update(rows: unknown) { return this.record('update', [rows]) }
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

const conv = await import('./conversations')

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
// findContactByWhatsappNumber — E.164 normalization
// ---------------------------------------------------------------------------

describe('findContactByWhatsappNumber', () => {
  it('normalizes the number to E.164 before querying', async () => {
    const q = setNextFrom({ data: { id: 'co-1', name: 'Alice', whatsapp_number: '+5491145678901' }, error: null })
    await conv.findContactByWhatsappNumber('+54 911 4567-8901')
    const eqCall = q.ops.find((o) => o.op === 'eq')
    expect(eqCall!.args).toEqual(['whatsapp_number', '+5491145678901'])
  })

  it('returns null when no contact matches', async () => {
    setNextFrom({ data: null, error: null })
    const out = await conv.findContactByWhatsappNumber('+549110000000')
    expect(out).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// findOrCreateConversationForContact — webhook hot path
// ---------------------------------------------------------------------------

describe('findOrCreateConversationForContact', () => {
  it('returns existing conversation without inserting', async () => {
    const q = setNextFrom({
      data: { id: 'c-1', contact_id: 'co-1', assigned_agent_id: null, status: 'open', last_message_at: null, last_message_preview: null, unread_count: 0, created_at: '2026-01-01' },
      error: null,
    })
    const out = await conv.findOrCreateConversationForContact('co-1')
    expect(out.id).toBe('c-1')
    expect(q.ops.some((o) => o.op === 'insert')).toBe(false)
  })

  it('creates a new conversation when none exists for the contact', async () => {
    const findQ = new QueryMock()
    findQ.payload = { data: null, error: null }
    const insertQ = new QueryMock()
    insertQ.payload = {
      data: { id: 'c-2', contact_id: 'co-1', assigned_agent_id: null, status: 'open', last_message_at: null, last_message_preview: null, unread_count: 0, created_at: '2026-02-01' },
      error: null,
    }
    mockAdmin.from.mockReturnValueOnce(findQ).mockReturnValueOnce(insertQ)

    const out = await conv.findOrCreateConversationForContact('co-1')
    expect(out.id).toBe('c-2')
    const insertCall = insertQ.ops.find((o) => o.op === 'insert')
    expect(insertCall!.args[0]).toEqual({ contact_id: 'co-1' })
  })

  it('throws on Supabase error during the initial find', async () => {
    setNextFrom({ data: null, error: { message: 'rls denied' } })
    await expect(conv.findOrCreateConversationForContact('co-1')).rejects.toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// appendInboundMessage — webhook idempotency
// ---------------------------------------------------------------------------

describe('appendInboundMessage', () => {
  it('upserts on twilio_sid with ignoreDuplicates: true', async () => {
    const q = setNextFrom({
      data: { id: 'm-1', conversation_id: 'c-1', direction: 'in', body: 'hola', media_urls: [], twilio_sid: 'SMabc', twilio_status: null, sent_by_id: null, created_at: '2026-01-01' },
      error: null,
    })
    const out = await conv.appendInboundMessage({
      conversation_id: 'c-1',
      body: 'hola',
      twilio_sid: 'SMabc',
    })
    expect(out.direction).toBe('in')
    expect(out.twilio_sid).toBe('SMabc')
    const upsertCall = q.ops.find((o) => o.op === 'upsert')
    expect(upsertCall).toBeDefined()
    const [rows, opts] = upsertCall!.args as [Record<string, unknown>, { onConflict: string; ignoreDuplicates: boolean }]
    expect(rows).toMatchObject({ conversation_id: 'c-1', direction: 'in', body: 'hola', twilio_sid: 'SMabc' })
    expect(rows.media_urls).toEqual([])
    expect(opts).toEqual({ onConflict: 'twilio_sid', ignoreDuplicates: true })
  })

  it('defaults media_urls to empty array when not provided', async () => {
    const q = setNextFrom({
      data: { id: 'm-2', conversation_id: 'c-1', direction: 'in', body: 'x', media_urls: [], twilio_sid: 'SMx', twilio_status: null, sent_by_id: null, created_at: '2026-01-01' },
      error: null,
    })
    await conv.appendInboundMessage({ conversation_id: 'c-1', body: 'x', twilio_sid: 'SMx' })
    const upsertCall = q.ops.find((o) => o.op === 'upsert')!
    const rows = upsertCall.args[0] as Record<string, unknown>
    expect(rows.media_urls).toEqual([])
  })

  it('forwards provided media_urls as-is', async () => {
    const q = setNextFrom({
      data: { id: 'm-3', conversation_id: 'c-1', direction: 'in', body: null, media_urls: [{ url: 'https://x/y.jpg' }], twilio_sid: 'SMy', twilio_status: null, sent_by_id: null, created_at: '2026-01-01' },
      error: null,
    })
    await conv.appendInboundMessage({ conversation_id: 'c-1', body: null, twilio_sid: 'SMy', media_urls: [{ url: 'https://x/y.jpg' }] })
    const upsertCall = q.ops.find((o) => o.op === 'upsert')!
    const rows = upsertCall.args[0] as Record<string, unknown>
    expect(rows.media_urls).toEqual([{ url: 'https://x/y.jpg' }])
    expect(rows.body).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// appendOutboundMessage
// ---------------------------------------------------------------------------

describe('appendOutboundMessage', () => {
  it('writes through the guarded function, with the actor and the twilio state', async () => {
    setNextRpc({
      data: {
        id: 'm-4',
        conversation_id: 'c-1',
        direction: 'out',
        body: 'hola',
        media_urls: [],
        twilio_sid: 'SMout',
        twilio_status: 'queued',
        sent_by_id: 'u-1',
        created_at: '2026-01-01',
      },
      error: null,
    })

    const message = await conv.appendOutboundMessage({
      conversation_id: 'c-1',
      body: 'hola',
      sent_by_id: 'u-1',
      twilio_sid: 'SMout',
    })

    const [fn, args] = mockAdmin.rpc.mock.calls[0]
    expect(fn).toBe('append_outbound_message')
    expect(args).toMatchObject({
      p_conversation_id: 'c-1',
      p_actor_id: 'u-1',
      p_body: 'hola',
      p_twilio_sid: 'SMout',
      p_twilio_status: 'queued',
    })
    expect(message.id).toBe('m-4')
  })

  it('leaves the twilio state null when there is no sid (deferred HTTP send)', async () => {
    setNextRpc({
      data: {
        id: 'm-5',
        conversation_id: 'c-1',
        direction: 'out',
        body: 'aún sin enviar',
        media_urls: [],
        twilio_sid: null,
        twilio_status: null,
        sent_by_id: 'u-1',
        created_at: '2026-01-01',
      },
      error: null,
    })

    await conv.appendOutboundMessage({
      conversation_id: 'c-1',
      body: 'aún sin enviar',
      sent_by_id: 'u-1',
    })

    expect(mockAdmin.rpc.mock.calls[0][1]).toMatchObject({
      p_twilio_sid: null,
      p_twilio_status: null,
    })
  })

  it('maps "the chat changed hands" to 409', async () => {
    setNextRpc({ data: null, error: { code: 'C0009', message: 'assignment_changed' } })
    await expect(
      conv.appendOutboundMessage({ conversation_id: 'c-1', body: 'hola', sent_by_id: 'u-2' }),
    ).rejects.toMatchObject({ code: 'assignment_changed', status: 409 })
  })

  it('maps "nobody holds this chat" to 409', async () => {
    setNextRpc({ data: null, error: { code: 'C0008', message: 'conversation_unassigned' } })
    await expect(
      conv.appendOutboundMessage({ conversation_id: 'c-1', body: 'hola', sent_by_id: 'u-1' }),
    ).rejects.toMatchObject({ code: 'conversation_unassigned', status: 409 })
  })
})

// ---------------------------------------------------------------------------
// updateMessageStatusBySid — Twilio status callback
// ---------------------------------------------------------------------------

describe('updateMessageStatusBySid', () => {
  it('updates twilio_status with eq on twilio_sid and reports matched count', async () => {
    const q = setNextFrom({ data: [{ id: 'm-1' }], error: null })
    const out = await conv.updateMessageStatusBySid('SMabc', 'delivered')
    expect(out).toEqual({ updated: true })
    const updateCall = q.ops.find((o) => o.op === 'update')
    expect(updateCall!.args[0]).toEqual({ twilio_status: 'delivered' })
    const eqCall = q.ops.find((o) => o.op === 'eq')
    expect(eqCall!.args).toEqual(['twilio_sid', 'SMabc'])
  })

  it('returns {updated: false} when no row matches the SID', async () => {
    setNextFrom({ data: [], error: null })
    const out = await conv.updateMessageStatusBySid('SMmissing', 'failed')
    expect(out).toEqual({ updated: false })
  })

  it('accepts every Twilio status enum', async () => {
    for (const status of ['queued', 'sent', 'delivered', 'read', 'failed'] as const) {
      mockAdmin.from.mockReset()
      setNextFrom({ data: [{ id: 'm-1' }], error: null })
      const out = await conv.updateMessageStatusBySid('SMabc', status)
      expect(out.updated).toBe(true)
    }
  })
})

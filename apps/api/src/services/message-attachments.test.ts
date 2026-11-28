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
  contains(col: string, val: unknown) { return this.record('contains', [col, val]) }
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
  rpc: vi.fn(),
  storage: {
    from: vi.fn(() => ({
      createSignedUrl: vi.fn(),
      remove: vi.fn(),
      download: vi.fn(),
    })),
  },
}

vi.mock('@/lib/supabase/admin', () => ({
  createSupabaseAdminClient: () => mockAdmin,
}))

const attachments = await import('./message-attachments')

beforeEach(() => {
  mockAdmin.from.mockReset()
  mockAdmin.rpc.mockReset()
  mockAdmin.rpc.mockResolvedValue({ data: null, error: null })
  mockAdmin.storage.from.mockReset()
})

/** El titular del ticket: puede leer y trabajar sus adjuntos. */
const holder = { id: 'u-1', role: 'soporte' as const, role_key: 'soporte' }
/** Un agente ajeno: ni titular del ticket ni de ningún chat. */
const outsider = { id: 'u-99', role: 'soporte' as const, role_key: 'soporte' }
/** Un agente que atiende UNO de los chats, pero no es titular del ticket. */
const chatOneAgent = { id: 'u-2', role: 'soporte' as const, role_key: 'soporte' }
/** La respuestas del ticket con su titular. */
const ticketOfHolder = { id: 'tk-1', assigned_to: 'u-1' }
/** Un supervisor: puede purgar. */
const supervisor = { id: 'u-50', role: 'supervisor' as const, role_key: 'supervisor' }

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

/** Una fila de `ticket_message_attachments` con su mensaje incrustado. */
function makeRow(over: Record<string, unknown> = {}) {
  return {
    ticket_id: 'tk-1',
    message_id: 'msg-1',
    attached_by: 'u-9',
    attached_at: '2026-01-02',
    note: null,
    messages: {
      body: 'hola',
      direction: 'in',
      created_at: '2026-01-01',
      conversation_id: 'cv-1',
      media_urls: [] as unknown[],
    },
    ...over,
  }
}

/** Un mensaje con su fila de adjunto, listo para el mock. */
function makeAttachmentRow(messageId: string, conversationId: string, mediaUrls: string[] = []) {
  return makeRow({
    message_id: messageId,
    messages: {
      body: 'hola',
      direction: 'in',
      created_at: '2026-01-01',
      conversation_id: conversationId,
      media_urls: mediaUrls,
    },
  })
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
    const out = await attachments.attachMessages('tk-1', [], 'u-1', undefined, holder)
    expect(out).toEqual({ attached: 0, skipped: 0 })
    expect(mockAdmin.from).not.toHaveBeenCalled()
  })

  it('refuses to attach to a ticket that does not exist', async () => {
    setNextFrom({ data: null, error: null }) // ticket lookup
    await expect(
      attachments.attachMessages('tk-ghost', ['msg-1'], 'u-1', undefined, holder),
    ).rejects.toMatchObject({ code: 'ticket_not_found', status: 404 })
  })

  it('refuses to attach to a trashed ticket', async () => {
    // The lookup filters deleted_at is null, so a trashed ticket yields no row.
    const q = setNextFrom({ data: null, error: null })
    await expect(
      attachments.attachMessages('tk-1', ['msg-1'], 'u-1', undefined, holder),
    ).rejects.toMatchObject({ code: 'ticket_not_found' })
    expect(q.ops.some((o) => o.op === 'is' && o.args[0] === 'deleted_at')).toBe(true)
  })

  it('refuses to attach when the caller does not own the ticket', async () => {
    setNextFrom({ data: ticketOfHolder, error: null }) // ticket lookup
    setNextFrom({ data: [makeAttachmentRow('msg-1', 'cv-1')], error: null }) // the attachments
    setNextFrom({ data: [], error: null }) // conversations owned by the caller

    await expect(
      attachments.attachMessages('tk-1', ['msg-1'], 'u-99', undefined, outsider),
    ).rejects.toMatchObject({ code: 'forbidden', status: 403 })
  })

  it('rejects message ids that do not exist', async () => {
    setNextFrom({ data: ticketOfHolder, error: null }) // ticket lookup
    setNextFrom({ data: [{ id: 'msg-1' }], error: null }) // only msg-1 exists

    await expect(
      attachments.attachMessages('tk-1', ['msg-1', 'msg-99'], 'u-1', undefined, holder),
    ).rejects.toMatchObject({ code: 'message_not_found' })
  })

  it('writes one row per message with the actor recorded', async () => {
    // El titular del ticket pasa el control de acceso con la sola lectura del
    // ticket: no hay filas que revisar.
    setNextFrom({ data: ticketOfHolder, error: null }) // ticket lookup
    setNextFrom({ data: [{ id: 'msg-1' }, { id: 'msg-2' }], error: null }) // messages
    setNextFrom({ data: [{ id: 'cv-1', assigned_agent_id: 'u-1' }], error: null }) // conversations
    const upQ = setNextFrom({ data: null, error: null }) // upsert

    const out = await attachments.attachMessages(
      'tk-1',
      ['msg-1', 'msg-2'],
      'u-9',
      undefined,
      holder,
    )

    const rows = upQ.ops.find((o) => o.op === 'upsert')?.args[0] as Array<Record<string, unknown>>
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({
      ticket_id: 'tk-1',
      message_id: 'msg-1',
      attached_by: 'u-9',
    })
    expect(out).toEqual({ attached: 2, skipped: 0 })
  })

  it('refuses to attach a message from a conversation the caller cannot see', async () => {
    setNextFrom({ data: ticketOfHolder, error: null }) // ticket lookup
    setNextFrom({ data: [{ id: 'msg-1' }], error: null }) // messages
    setNextFrom({ data: [{ id: 'cv-9', assigned_agent_id: 'u-42' }], error: null }) // conversations

    await expect(
      attachments.attachMessages('tk-1', ['msg-1'], 'u-9', undefined, holder),
    ).rejects.toMatchObject({ code: 'forbidden', status: 403 })
  })

  it('is idempotent: re-attaching the same message is a no-op upsert', async () => {
    setNextFrom({ data: ticketOfHolder, error: null })
    setNextFrom({ data: [{ id: 'msg-1' }], error: null })
    setNextFrom({ data: [{ id: 'cv-1', assigned_agent_id: 'u-1' }], error: null })
    const upQ = setNextFrom({ data: null, error: null })

    await attachments.attachMessages('tk-1', ['msg-1'], 'u-9', undefined, holder)

    const opts = upQ.ops.find((o) => o.op === 'upsert')?.args[1] as
      | { onConflict: string; ignoreDuplicates: boolean }
      | undefined
    expect(opts?.onConflict).toBe('ticket_id,message_id')
    expect(opts?.ignoreDuplicates).toBe(true)
  })

  it('stores the optional note', async () => {
    setNextFrom({ data: ticketOfHolder, error: null })
    setNextFrom({ data: [{ id: 'msg-1' }], error: null })
    setNextFrom({ data: [{ id: 'cv-1', assigned_agent_id: 'u-1' }], error: null })
    const upQ = setNextFrom({ data: null, error: null })

    await attachments.attachMessages(
      'tk-1',
      ['msg-1'],
      'u-9',
      'el que prueba el retraso',
      holder,
    )

    const rows = upQ.ops.find((o) => o.op === 'upsert')?.args[0] as Array<Record<string, unknown>>
    expect(rows[0]!.note).toBe('el que prueba el retraso')
  })
})

// ---------------------------------------------------------------------------
// listTicketAttachments — la visibilidad se decide POR ADJUNTO
// ---------------------------------------------------------------------------

describe('listTicketAttachments', () => {
  it('flattens the embedded message FK', async () => {
    setNextFrom({ data: ticketOfHolder, error: null }) // ticket lookup
    setNextFrom({ data: [makeAttachmentRow('msg-1', 'cv-1')], error: null }) // the attachments

    const out = await attachments.listTicketAttachments('tk-1', holder)

    expect(out[0]).toMatchObject({
      message_id: 'msg-1',
      body: 'hola',
      direction: 'in',
      attached_by: 'u-9',
    })
  })

  it('survives a missing embedded message instead of throwing', async () => {
    setNextFrom({ data: ticketOfHolder, error: null }) // ticket lookup
    setNextFrom({
      data: [makeRow({ messages: null })],
      error: null,
    })

    const out = await attachments.listTicketAttachments('tk-1', holder)
    expect(out[0]?.body).toBeNull()
    expect(out[0]?.direction).toBe('in')
  })

  it('refuses to list the attachments of a ticket the caller does not own', async () => {
    setNextFrom({ data: ticketOfHolder, error: null }) // ticket lookup
    setNextFrom({ data: [makeAttachmentRow('msg-1', 'cv-1')], error: null }) // the attachments
    setNextFrom({ data: [], error: null }) // conversations owned by the caller

    await expect(
      attachments.listTicketAttachments('tk-1', outsider),
    ).rejects.toMatchObject({ code: 'forbidden', status: 403 })
  })

  it('el titular del ticket ve la evidencia de TODOS los chats', async () => {
    setNextFrom({ data: ticketOfHolder, error: null }) // ticket lookup
    setNextFrom({
      data: [
        makeAttachmentRow('msg-a', 'cv-1'),
        makeAttachmentRow('msg-b', 'cv-2'),
      ],
      error: null,
    })

    const out = await attachments.listTicketAttachments('tk-1', holder)

    expect(out.map((a) => a.message_id)).toEqual(['msg-a', 'msg-b'])
  })

  it('quien solo atiende un chat ve únicamente la evidencia de ese chat', async () => {
    setNextFrom({ data: ticketOfHolder, error: null }) // ticket lookup
    setNextFrom({
      data: [
        makeAttachmentRow('msg-a', 'cv-1'),
        makeAttachmentRow('msg-b', 'cv-2'),
      ],
      error: null,
    })
    setNextFrom({ data: [{ id: 'cv-1' }], error: null }) // conversations owned by the caller

    const out = await attachments.listTicketAttachments('tk-1', chatOneAgent)

    expect(out.map((a) => a.message_id)).toEqual(['msg-a'])
  })

  it('informa si el adjunto trae archivo propio y con qué nombre', async () => {
    setNextFrom({ data: ticketOfHolder, error: null })
    setNextFrom({
      data: [makeAttachmentRow('msg-a', 'cv-1', ['attachments/cv-1/factura.pdf'])],
      error: null,
    })

    const out = await attachments.listTicketAttachments('tk-1', holder)

    expect(out[0]?.has_file).toBe(true)
    expect(out[0]?.filename).toBe('factura.pdf')
  })
})

// ---------------------------------------------------------------------------
// detachMessage — desvincular NUNCA borra el objeto
// ---------------------------------------------------------------------------

describe('detachMessage', () => {
  it('deletes the attachment row scoped to the ticket', async () => {
    setNextFrom({ data: ticketOfHolder, error: null }) // ticket lookup
    setNextFrom({ data: [makeAttachmentRow('msg-1', 'cv-1')], error: null }) // the attachments
    const q = setNextFrom({ data: null, error: null }) // the delete

    await expect(
      attachments.detachMessage('tk-1', 'msg-1', holder),
    ).resolves.toEqual({ detached: true, file_deleted: false })

    const eqs = q.ops.filter((o) => o.op === 'eq').map((o) => o.args)
    expect(eqs).toContainEqual(['ticket_id', 'tk-1'])
    expect(eqs).toContainEqual(['message_id', 'msg-1'])
  })

  it('NUNCA borra el objeto de Storage: el archivo puede seguir en otro ticket', async () => {
    setNextFrom({ data: ticketOfHolder, error: null }) // ticket lookup
    setNextFrom({
      data: [makeAttachmentRow('msg-1', 'cv-1', ['attachments/cv-1/factura.pdf'])],
      error: null,
    })
    setNextFrom({ data: null, error: null }) // the delete

    await attachments.detachMessage('tk-1', 'msg-1', holder)

    expect(mockAdmin.storage.from).not.toHaveBeenCalled()
  })

  it('refuses to detach when the caller does not own the ticket', async () => {
    setNextFrom({ data: ticketOfHolder, error: null }) // ticket lookup
    setNextFrom({ data: [makeAttachmentRow('msg-1', 'cv-1')], error: null }) // the attachments
    setNextFrom({ data: [], error: null }) // conversations owned by the caller

    await expect(
      attachments.detachMessage('tk-1', 'msg-1', outsider),
    ).rejects.toMatchObject({ code: 'forbidden', status: 403 })
  })

  it('refuses to detach evidence from a chat the caller does not attend', async () => {
    setNextFrom({ data: ticketOfHolder, error: null }) // ticket lookup
    setNextFrom({
      data: [
        makeAttachmentRow('msg-a', 'cv-1'),
        makeAttachmentRow('msg-b', 'cv-2'),
      ],
      error: null,
    })
    setNextFrom({ data: [{ id: 'cv-1' }], error: null }) // conversations owned by the caller

    await expect(
      attachments.detachMessage('tk-1', 'msg-b', chatOneAgent),
    ).rejects.toMatchObject({ code: 'forbidden', status: 403 })
  })
})

// ---------------------------------------------------------------------------
// downloadAttachment — la API sirve los bytes y re-comprueba en cada petición
// ---------------------------------------------------------------------------

describe('downloadAttachment', () => {
  it('devuelve los bytes del archivo y nunca una URL firmada', async () => {
    setNextFrom({ data: ticketOfHolder, error: null }) // ticket lookup
    setNextFrom({
      data: [makeAttachmentRow('msg-1', 'cv-1', ['attachments/cv-1/factura.pdf'])],
      error: null,
    })
    const createSignedUrl = vi.fn()
    const download = vi.fn().mockResolvedValue({
      data: new Blob(['contenido'], { type: 'application/pdf' }),
      error: null,
    })
    mockAdmin.storage.from.mockReturnValue({ createSignedUrl, remove: vi.fn(), download })

    const out = await attachments.downloadAttachment('tk-1', 'msg-1', holder)

    expect(createSignedUrl).not.toHaveBeenCalled()
    expect(download).toHaveBeenCalledWith('attachments/cv-1/factura.pdf')
    expect(out.content_type).toBe('application/pdf')
    expect(out.filename).toBe('factura.pdf')
    expect(Buffer.from(out.data).toString('utf8')).toBe('contenido')
  })

  it('usa application/octet-stream cuando el tipo de contenido se desconoce', async () => {
    setNextFrom({ data: ticketOfHolder, error: null })
    setNextFrom({
      data: [makeAttachmentRow('msg-1', 'cv-1', ['attachments/cv-1/factura.pdf'])],
      error: null,
    })
    const download = vi.fn().mockResolvedValue({
      data: new Blob(['contenido']),
      error: null,
    })
    mockAdmin.storage.from.mockReturnValue({ createSignedUrl: vi.fn(), remove: vi.fn(), download })

    const out = await attachments.downloadAttachment('tk-1', 'msg-1', holder)

    expect(out.content_type).toBe('application/octet-stream')
  })

  it('nunca sirve una URL externa de Twilio', async () => {
    setNextFrom({ data: ticketOfHolder, error: null })
    setNextFrom({
      data: [makeAttachmentRow('msg-1', 'cv-1', ['https://api.twilio.com/media/abc'])],
      error: null,
    })
    const download = vi.fn()
    mockAdmin.storage.from.mockReturnValue({ createSignedUrl: vi.fn(), remove: vi.fn(), download })

    await expect(
      attachments.downloadAttachment('tk-1', 'msg-1', holder),
    ).rejects.toMatchObject({ code: 'attachment_file_not_found', status: 404 })
    expect(download).not.toHaveBeenCalled()
  })

  it('re-checks authorization on every request: the other chat is refused', async () => {
    setNextFrom({ data: ticketOfHolder, error: null }) // ticket lookup
    setNextFrom({
      data: [
        makeAttachmentRow('msg-a', 'cv-1'),
        makeAttachmentRow('msg-b', 'cv-2'),
      ],
      error: null,
    })
    setNextFrom({ data: [{ id: 'cv-1' }], error: null }) // conversations owned by the caller
    const download = vi.fn()
    mockAdmin.storage.from.mockReturnValue({ createSignedUrl: vi.fn(), remove: vi.fn(), download })

    await expect(
      attachments.downloadAttachment('tk-1', 'msg-b', chatOneAgent),
    ).rejects.toMatchObject({ code: 'forbidden', status: 403 })
    expect(download).not.toHaveBeenCalled()
  })

  it('answers 404 when the message is not attached to the ticket', async () => {
    setNextFrom({ data: ticketOfHolder, error: null }) // ticket lookup
    setNextFrom({ data: [makeAttachmentRow('msg-a', 'cv-1')], error: null }) // the attachments

    await expect(
      attachments.downloadAttachment('tk-1', 'msg-zzz', holder),
    ).rejects.toMatchObject({ code: 'attachment_not_found', status: 404 })
  })
})

// ---------------------------------------------------------------------------
// purgeAttachment — el borrado físico es una operación aparte y autorizada
// ---------------------------------------------------------------------------

describe('purgeAttachment', () => {
  const oldEnough = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString()
  const tooRecent = new Date().toISOString()

  it('refuses when the actor is not an admin or supervisor', async () => {
    await expect(
      attachments.purgeAttachment('tk-1', 'msg-1', holder, 'control'),
    ).rejects.toMatchObject({ code: 'forbidden', status: 403 })
    expect(mockAdmin.from).not.toHaveBeenCalled()
  })

  it('refuses while another ticket still references the same path', async () => {
    setNextFrom({ data: ticketOfHolder, error: null }) // ticket lookup
    setNextFrom({
      data: { id: 'msg-1', media_urls: ['attachments/cv-1/factura.pdf'], created_at: oldEnough },
      error: null,
    }) // the message
    setNextFrom({ data: [{ id: 'msg-1' }], error: null }) // messages holding the path
    setNextFrom({
      data: [{ ticket_id: 'tk-9', message_id: 'msg-1' }],
      error: null,
    }) // links to those messages

    await expect(
      attachments.purgeAttachment('tk-1', 'msg-1', supervisor, 'control'),
    ).rejects.toMatchObject({ code: 'attachment_referenced', status: 409 })
  })

  it('refuses while the retention window has not elapsed', async () => {
    setNextFrom({ data: ticketOfHolder, error: null }) // ticket lookup
    setNextFrom({
      data: { id: 'msg-1', media_urls: ['attachments/cv-1/factura.pdf'], created_at: tooRecent },
      error: null,
    }) // the message
    setNextFrom({ data: [{ id: 'msg-1' }], error: null }) // messages holding the path
    setNextFrom({
      data: [{ ticket_id: 'tk-1', message_id: 'msg-1' }],
      error: null,
    }) // only the link being purged

    await expect(
      attachments.purgeAttachment('tk-1', 'msg-1', supervisor, 'control'),
    ).rejects.toMatchObject({ code: 'attachment_retention_window', status: 409 })
  })

  it('deletes the object and leaves the trail when nothing references it', async () => {
    setNextFrom({ data: ticketOfHolder, error: null }) // ticket lookup
    setNextFrom({
      data: { id: 'msg-1', media_urls: ['attachments/cv-1/factura.pdf'], created_at: oldEnough },
      error: null,
    }) // the message
    setNextFrom({ data: [{ id: 'msg-1' }], error: null }) // messages holding the path
    setNextFrom({
      data: [{ ticket_id: 'tk-1', message_id: 'msg-1' }],
      error: null,
    }) // only the link being purged
    const remove = vi.fn().mockResolvedValue({ data: null, error: null })
    mockAdmin.storage.from.mockReturnValue({ createSignedUrl: vi.fn(), remove, download: vi.fn() })

    const out = await attachments.purgeAttachment('tk-1', 'msg-1', supervisor, 'control de purga')

    expect(out).toMatchObject({
      purged: true,
      ticket_id: 'tk-1',
      message_id: 'msg-1',
      path: 'attachments/cv-1/factura.pdf',
    })
    expect(mockAdmin.rpc).toHaveBeenCalledWith('purge_attachment_record', {
      p_ticket_id: 'tk-1',
      p_message_id: 'msg-1',
      p_actor_id: 'u-50',
      p_media_path: 'attachments/cv-1/factura.pdf',
      p_reason: 'control de purga',
    })
    expect(remove).toHaveBeenCalledWith(['attachments/cv-1/factura.pdf'])
  })
})

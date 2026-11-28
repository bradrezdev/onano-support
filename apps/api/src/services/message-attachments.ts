/**
 * Message attachments (W1).
 *
 * Selecting messages from a conversation and pinning them to a ticket is what
 * turns "the customer said something" into evidence. The alternative — a
 * link back to the chat — makes the reader do the work at the exact moment
 * they most need the answer.
 *
 * Both directions are enforced server-side:
 *   - the message must belong to a conversation this caller can see
 *   - the ticket must exist and not be in the trash
 *   - the ticket must belong to the caller: its holder, the holder of one of
 *     the conversations the attached messages come from, or an admin/supervisor
 *
 * Otherwise anyone could attach a message from a private chat to any ticket
 * and leak it.
 *
 * LA VISIBILIDAD SE DECIDE POR ADJUNTO, NO POR TICKET. Un ticket puede reunir
 * evidencia de varios chats y cada fila tiene su propio dueño: el titular del
 * ticket ve todo lo que cuelga de él, pero quien solo atiende UNO de los chats
 * ve únicamente la evidencia de ese chat. El listado filtra fila por fila y
 * la descarga aplica la misma regla: quien no puede ver una fila no puede
 * abrirla.
 *
 * El archivo lo sirve la API, en BYTES, después de comprobar la
 * autorización en cada petición. Antes se emitía una URL firmada que sobrevivía
 * cinco minutos a la pérdida de permiso; una URL emitida sigue viva aunque el
 * agente ya no pueda ver el recurso. Por eso el bucket `whatsapp-media` es
 * privado y el navegador nunca habla con Storage.
 *
 * DESVINCULAR NUNCA BORRA EL OBJETO: la misma ruta puede vivir en otro ticket
 * o en otro mensaje, y borrar el archivo dejaría roto al que todavía lo
 * referencia. El borrado físico es una operación aparte (`purgeAttachment`),
 * reservada a admin/supervisor, que comprueba que no queda ninguna referencia
 * y que se respetó la ventana de conservación, y que deja bitácora.
 *
 * Objects owned by the app live under the `attachments/` prefix of the
 * bucket. `media_urls` pointing to Twilio (https://...) are external: they
 * are never served from here and never deleted.
 */

import { createSupabaseAdminClient } from '@/lib/supabase/admin'
import { canAccessConversation, isPrivileged } from '@/services/conversations'

/** Prefix of the objects this app owns inside the `whatsapp-media` bucket. */
export const MEDIA_BUCKET = 'whatsapp-media'
export const MEDIA_PREFIX = 'attachments/'

/**
 * Días de conservación por defecto. Es un SUPUESTO DECLARADO, no una política
 * de negocio inventada: se configura con `RETENTION_DAYS`.
 */
export const DEFAULT_RETENTION_DAYS = 30

export interface AttachmentViewer {
  id: string
  role: 'admin' | 'supervisor' | 'soporte'
  role_key: string
}

export interface AttachedMessage {
  message_id: string
  ticket_id: string
  body: string | null
  direction: 'in' | 'out'
  created_at: string
  attached_by: string | null
  attached_at: string
  note: string | null
  /** El adjunto trae un archivo propio del bucket (no una URL externa). */
  has_file: boolean
  /** Nombre del archivo, para la vista previa y la descarga. */
  filename: string | null
}

/** Los bytes de un archivo, servidos por la API tras autorizar al actor. */
export interface AttachmentFile {
  message_id: string
  ticket_id: string
  /** Ruta del objeto dentro del bucket. */
  path: string
  /** Nombre del archivo tal como lo muestra el navegador. */
  filename: string
  /** Tipo de contenido almacenado; `application/octet-stream` si se desconoce. */
  content_type: string
  data: ArrayBuffer
}

/** El resultado de una purga autorizada. */
export interface PurgeResult {
  purged: true
  ticket_id: string
  message_id: string
  path: string
}

export class AttachmentError extends Error {
  status: number
  code: string
  constructor(code: string, message: string, status = 400) {
    super(message)
    this.code = code
    this.status = status
  }
}

/**
 * Una fila de `ticket_message_attachments` con su mensaje incrustado: el
 * mensaje trae el chat del que viene, que es lo que decide la visibilidad.
 */
interface AttachmentRow {
  ticket_id: string
  message_id: string
  attached_by: string | null
  attached_at: string
  note: string | null
  messages: {
    body: string | null
    direction: 'in' | 'out'
    created_at: string
    conversation_id: string | null
    media_urls: unknown
  } | null
}

const ATTACHMENT_COLUMNS =
  'ticket_id, message_id, attached_by, attached_at, note, ' +
  'messages!ticket_message_attachments_message_id_fkey(body, direction, created_at, conversation_id, media_urls)'

/**
 * The messages a conversation offers as attachable candidates: the ones not
 * already pinned to this ticket.
 */
export async function listAttachableMessages(
  conversationId: string,
  ticketId: string,
  limit = 50,
): Promise<Array<{ id: string; body: string | null; direction: 'in' | 'out'; created_at: string }>> {
  const admin = createSupabaseAdminClient()

  const { data: already, error: aErr } = await admin
    .from('ticket_message_attachments')
    .select('message_id')
    .eq('ticket_id', ticketId)
  if (aErr) throw aErr

  const taken = new Set(
    ((already ?? []) as Array<{ message_id: string }>).map((r) => r.message_id),
  )

  const { data, error } = await admin
    .from('messages')
    .select('id, body, direction, created_at')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error) throw error

  return ((data ?? []) as Array<{
    id: string
    body: string | null
    direction: 'in' | 'out'
    created_at: string
  }>)
    .filter((m) => !taken.has(m.id))
    .map((m) => ({
      id: m.id,
      body: m.body,
      direction: m.direction,
      created_at: m.created_at,
    }))
}

/** El ticket: si no existe o está en la papelera, no hay adjuntos que ver. */
async function loadTicket(ticketId: string): Promise<{ id: string; assigned_to: string | null }> {
  const admin = createSupabaseAdminClient()

  const { data, error } = await admin
    .from('tickets')
    .select('id, assigned_to')
    .eq('id', ticketId)
    .is('deleted_at', null)
    .maybeSingle<{ id: string; assigned_to: string | null }>()
  if (error) throw error
  if (!data) {
    throw new AttachmentError('ticket_not_found', 'El ticket no existe', 404)
  }
  return data
}

/** Las filas del ticket con su mensaje incrustado. */
async function loadAttachmentRows(ticketId: string): Promise<AttachmentRow[]> {
  const admin = createSupabaseAdminClient()

  const { data, error } = await admin
    .from('ticket_message_attachments')
    .select(ATTACHMENT_COLUMNS)
    .eq('ticket_id', ticketId)
    .order('attached_at', { ascending: false })
  if (error) throw error

  return ((data ?? []) as unknown as AttachmentRow[])
}

/** Los chats de los que viene la evidencia que el actor atiende. */
async function loadOwnedConversations(
  viewer: AttachmentViewer,
  rows: AttachmentRow[],
): Promise<Set<string>> {
  const conversationIds = [
    ...new Set(
      rows
        .map((r) => r.messages?.conversation_id)
        .filter((id): id is string => Boolean(id)),
    ),
  ]
  if (conversationIds.length === 0) return new Set()

  const admin = createSupabaseAdminClient()
  const { data, error } = await admin
    .from('conversations')
    .select('id')
    .in('id', conversationIds)
    .eq('assigned_agent_id', viewer.id)
  if (error) throw error

  return new Set(((data ?? []) as Array<{ id: string }>).map((r) => r.id))
}

/**
 * ¿Puede este actor ver ESTE adjunto?
 *
 * Tres puertas, y basta con una:
 *   - `admin` / `supervisor`
 *   - el titular del ticket (`tickets.assigned_to`)
 *   - el titular del chat del que viene el mensaje (`assigned_agent_id`)
 */
function isRowVisible(
  viewer: AttachmentViewer,
  ticket: { assigned_to: string | null },
  ownedConversations: Set<string>,
  row: AttachmentRow,
): boolean {
  if (isPrivileged(viewer)) return true
  if (ticket.assigned_to === viewer.id) return true
  const conversationId = row.messages?.conversation_id
  return Boolean(conversationId && ownedConversations.has(conversationId))
}

/**
 * El acceso al ticket como conjunto: el actor puede ver alguna de sus filas.
 *
 * Un ticket sin evidencia y sin titular es de nadie: ni un agente sin
 * privilegio ve nada.
 */
function canSeeAnyRow(
  viewer: AttachmentViewer,
  ticket: { assigned_to: string | null },
  ownedConversations: Set<string>,
  rows: AttachmentRow[],
): boolean {
  if (isPrivileged(viewer)) return true
  if (ticket.assigned_to === viewer.id) return true
  return rows.some((row) => isRowVisible(viewer, ticket, ownedConversations, row))
}

/**
 * Who may read the attachments of a ticket:
 *   - the ticket's holder (`tickets.assigned_to`)
 *   - the holder of one of the conversations the attached messages come from
 *   - admin / supervisor
 *
 * A ticket with no holder and no attached conversation is nobody's: even an
 * unprivileged agent gets nothing.
 */
export async function canAccessTicketAttachments(
  viewer: AttachmentViewer,
  ticketId: string,
): Promise<boolean> {
  const ticket = await loadTicket(ticketId)
  if (isPrivileged(viewer)) return true
  if (ticket.assigned_to === viewer.id) return true

  const rows = await loadAttachmentRows(ticketId)
  const owned = await loadOwnedConversations(viewer, rows)
  return canSeeAnyRow(viewer, ticket, owned, rows)
}
/** Throws 403 unless the viewer may read this ticket's attachments. */
export async function assertTicketAttachmentAccess(
  viewer: AttachmentViewer,
  ticketId: string,
): Promise<void> {
  const allowed = await canAccessTicketAttachments(viewer, ticketId)
  if (!allowed) {
    throw new AttachmentError(
      'forbidden',
      'No tienes acceso a los adjuntos de este ticket',
      403,
    )
  }
}

/**
 * El acceso a UN adjunto concreto.
 *
 * El permiso del ticket no basta: quien atiende un solo chat de un ticket
 * con evidencia de dos no puede abrir (ni desvincular) la del otro chat.
 */
export async function assertAttachmentAccess(
  viewer: AttachmentViewer,
  ticketId: string,
  messageId: string,
): Promise<AttachmentRow> {
  const ticket = await loadTicket(ticketId)
  const rows = await loadAttachmentRows(ticketId)
  const owned =
    isPrivileged(viewer) || ticket.assigned_to === viewer.id
      ? new Set<string>()
      : await loadOwnedConversations(viewer, rows)

  if (!canSeeAnyRow(viewer, ticket, owned, rows)) {
    throw new AttachmentError(
      'forbidden',
      'No tienes acceso a los adjuntos de este ticket',
      403,
    )
  }

  const row = rows.find((r) => r.message_id === messageId)
  if (!row) {
    throw new AttachmentError(
      'attachment_not_found',
      'El mensaje no está adjunto a este ticket',
      404,
    )
  }

  if (!isRowVisible(viewer, ticket, owned, row)) {
    throw new AttachmentError(
      'forbidden',
      'No tienes acceso a este adjunto',
      403,
    )
  }

  return row
}

/**
 * The evidence of a ticket, FILTRADA FILA POR FILA.
 *
 * The ticket's holder sees every row; an agent who attends only one of the
 * conversations sees only that conversation's rows. A caller with no access at
 * all gets nothing (403), exactly as before.
 */
export async function listTicketAttachments(
  ticketId: string,
  viewer: AttachmentViewer,
): Promise<AttachedMessage[]> {
  const ticket = await loadTicket(ticketId)
  const rows = await loadAttachmentRows(ticketId)
  const owned =
    isPrivileged(viewer) || ticket.assigned_to === viewer.id
      ? new Set<string>()
      : await loadOwnedConversations(viewer, rows)

  if (!canSeeAnyRow(viewer, ticket, owned, rows)) {
    throw new AttachmentError(
      'forbidden',
      'No tienes acceso a los adjuntos de este ticket',
      403,
    )
  }

  return rows
    .filter((row) => isRowVisible(viewer, ticket, owned, row))
    .map((row) => {
      const path = ownedMediaPaths(row.messages?.media_urls)[0] ?? null
      return {
        message_id: row.message_id,
        ticket_id: row.ticket_id,
        body: row.messages?.body ?? null,
        direction: row.messages?.direction ?? 'in',
        created_at: row.messages?.created_at ?? row.attached_at,
        attached_by: row.attached_by,
        attached_at: row.attached_at,
        note: row.note,
        has_file: path !== null,
        filename: path ? attachmentFilename(path) : null,
      }
    })
}

/**
 * Pin messages to a ticket.
 *
 * Idempotent on the (ticket, message) pair: re-selecting the same message is
 * a no-op, not a constraint violation. Attachments are additive by nature.
 */
export async function attachMessages(
  ticketId: string,
  messageIds: string[],
  actorId: string,
  note: string | undefined,
  viewer: AttachmentViewer,
): Promise<{ attached: number; skipped: number }> {
  if (messageIds.length === 0) {
    return { attached: 0, skipped: 0 }
  }

  const admin = createSupabaseAdminClient()

  // El ticket tiene que existir y el que adjunta debe poder trabajarlo.
  // `assertTicketAttachmentAccess` cubre ambas cosas.
  await assertTicketAttachmentAccess(viewer, ticketId)

  const { data: messages, error: mErr } = await admin
    .from('messages')
    .select('id, conversation_id')
    .in('id', messageIds)
  if (mErr) throw mErr

  const found = new Set(
    ((messages ?? []) as Array<{ id: string }>).map((r) => r.id),
  )
  const unknown = messageIds.filter((id) => !found.has(id))
  if (unknown.length > 0) {
    throw new AttachmentError(
      'message_not_found',
      `${unknown.length} mensaje(s) no existen`,
      400,
    )
  }

  // Y el mensaje debe venir de una conversación que el actor puede ver:
  // adjuntar evidencia de un chat ajeno es una vía de fuga.
  const conversationIds = [
    ...new Set(
      ((messages ?? []) as Array<{ conversation_id: string }>).map(
        (m) => m.conversation_id,
      ),
    ),
  ]
  const { data: conversations, error: cErr } = await admin
    .from('conversations')
    .select('id, assigned_agent_id')
    .in('id', conversationIds)
  if (cErr) throw cErr
  const forbidden = ((conversations ?? []) as Array<{
    id: string
    assigned_agent_id: string | null
  }>).some((c) => !canAccessConversation(viewer, c))
  if (forbidden) {
    throw new AttachmentError(
      'forbidden',
      'No tienes acceso a alguno de los mensajes seleccionados',
      403,
    )
  }

  const { error } = await admin
    .from('ticket_message_attachments')
    .upsert(
      messageIds.map((message_id) => ({
        ticket_id: ticketId,
        message_id,
        attached_by: actorId,
        note: note ?? null,
      })),
      { onConflict: 'ticket_id,message_id', ignoreDuplicates: true },
    )
  if (error) throw error

  return {
    attached: messageIds.length - unknown.length,
    skipped: 0,
  }
}

/**
 * The object paths this app owns inside the bucket: only entries under the
 * `attachments/` prefix. Everything else (Twilio URLs) is external.
 */
export function ownedMediaPaths(mediaUrls: unknown): string[] {
  if (!Array.isArray(mediaUrls)) return []
  return mediaUrls
    .filter((u): u is string => typeof u === 'string')
    .filter((u) => u.startsWith(MEDIA_PREFIX))
}

/** El nombre del archivo: el último segmento de la ruta. */
export function attachmentFilename(path: string): string {
  const parts = path.split('/').filter(Boolean)
  const base = parts.length > 0 ? parts[parts.length - 1] : ''
  return base.length > 0 ? base : 'archivo'
}

/**
 * Unpin a message.
 *
 * The row in `ticket_message_attachments` disappears; the message in
 * `messages` does not. Unpinning is a judgement ("this was the wrong
 * evidence"), never a way to delete a message.
 *
 * The OBJECT DOES NOT GO AWAY: the same `attachments/…` path can be linked to
 * another ticket (or live in another message), and deleting it here would
 * leave that other reference pointing at nothing. The physical deletion is a
 * separate authorized operation: `purgeAttachment`.
 */
export async function detachMessage(
  ticketId: string,
  messageId: string,
  viewer: AttachmentViewer,
): Promise<{ detached: true; file_deleted: false }> {
  const admin = createSupabaseAdminClient()

  await assertAttachmentAccess(viewer, ticketId, messageId)

  const { error } = await admin
    .from('ticket_message_attachments')
    .delete()
    .eq('ticket_id', ticketId)
    .eq('message_id', messageId)
  if (error) throw error

  return { detached: true, file_deleted: false }
}

/**
 * The bytes of an attachment's file.
 *
 * The API authorizes the caller ON THIS REQUEST and then serves the object:
 * the browser never receives a signed URL, so losing the permission closes
 * the door immediately instead of five minutes later.
 */
export async function downloadAttachment(
  ticketId: string,
  messageId: string,
  viewer: AttachmentViewer,
): Promise<AttachmentFile> {
  const admin = createSupabaseAdminClient()

  const row = await assertAttachmentAccess(viewer, ticketId, messageId)

  const path = ownedMediaPaths(row.messages?.media_urls)[0]
  if (!path) {
    throw new AttachmentError(
      'attachment_file_not_found',
      'Este adjunto no tiene un archivo propio',
      404,
    )
  }

  const { data: blob, error } = await admin.storage.from(MEDIA_BUCKET).download(path)
  if (error || !blob) {
    throw new AttachmentError(
      'attachment_file_not_found',
      'El archivo ya no está disponible',
      404,
    )
  }

  const contentType =
    typeof blob.type === 'string' && blob.type.trim().length > 0
      ? blob.type
      : 'application/octet-stream'

  return {
    message_id: row.message_id,
    ticket_id: row.ticket_id,
    path,
    filename: attachmentFilename(path),
    content_type: contentType,
    data: await blob.arrayBuffer(),
  }
}

/**
 * Días de conservación: `RETENTION_DAYS` (por defecto 30). Un valor que no
 * sea un número válido no inventa una política: se usa el valor por defecto.
 */
export function retentionDays(): number {
  const raw = process.env.RETENTION_DAYS
  if (!raw) return DEFAULT_RETENTION_DAYS
  const days = Number.parseInt(raw, 10)
  if (!Number.isFinite(days) || days < 0) return DEFAULT_RETENTION_DAYS
  return days
}

/**
 * El borrado FÍSICO del archivo, como operación aparte y autorizada.
 *
 * Tres condiciones, todas obligatorias:
 *   - el actor es `admin` o `supervisor`
 *   - no queda ninguna referencia: ningún `ticket_message_attachments` apunta
 *     a un mensaje cuyo `media_urls` incluye esa ruta (el vínculo que se está
 *     purgando no cuenta; el de otro ticket sí)
 *   - se respetó la ventana de conservación: el mensaje que guarda la ruta
 *     tiene que ser más viejo que `RETENTION_DAYS`
 *
 * Y deja bitácora: quién, qué ticket, qué mensaje, qué ruta, cuándo y por
 * qué, en una tabla append-only (`attachment_purge_log`).
 */
export async function purgeAttachment(
  ticketId: string,
  messageId: string,
  viewer: AttachmentViewer,
  reason: string,
): Promise<PurgeResult> {
  const admin = createSupabaseAdminClient()

  if (!isPrivileged(viewer)) {
    throw new AttachmentError(
      'forbidden',
      'Solo un administrador o un supervisor puede purgar un archivo',
      403,
    )
  }

  const ticket = await loadTicket(ticketId)

  const { data: message, error: mErr } = await admin
    .from('messages')
    .select('id, media_urls, created_at')
    .eq('id', messageId)
    .maybeSingle<{ id: string; media_urls: unknown; created_at: string }>()
  if (mErr) throw mErr
  if (!message) {
    throw new AttachmentError('message_not_found', 'El mensaje no existe', 404)
  }

  const path = ownedMediaPaths(message.media_urls)[0]
  if (!path) {
    throw new AttachmentError(
      'attachment_file_not_found',
      'Este mensaje no tiene un archivo propio',
      404,
    )
  }

  // ¿QUEDA ALGUNA REFERENCIA? Cualquier vínculo de ticket a un mensaje que
  // lleva esa ruta. El vínculo que se está purgando no cuenta (desaparece con
  // la purga); el de otro ticket, sí.
  const { data: holders, error: hErr } = await admin
    .from('messages')
    .select('id')
    .contains('media_urls', JSON.stringify([path]))
  if (hErr) throw hErr

  const messageIds = ((holders ?? []) as Array<{ id: string }>).map((m) => m.id)
  if (messageIds.length > 0) {
    const { data: links, error: lErr } = await admin
      .from('ticket_message_attachments')
      .select('ticket_id, message_id')
      .in('message_id', messageIds)
    if (lErr) throw lErr

    const remaining = ((links ?? []) as Array<{ ticket_id: string; message_id: string }>)
      .filter((l) => !(l.ticket_id === ticketId && l.message_id === messageId))
    if (remaining.length > 0) {
      throw new AttachmentError(
        'attachment_referenced',
        'El archivo todavía está referenciado por otro adjunto',
        409,
      )
    }
  }

  // La ventana de conservación: el mensaje que guarda la ruta tiene que ser
  // más viejo que la ventana configurada.
  const days = retentionDays()
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000
  if (new Date(message.created_at).getTime() > cutoff) {
    throw new AttachmentError(
      'attachment_retention_window',
      `El archivo se conserva ${days} días antes de poder purgarlo`,
      409,
    )
  }

  // La bitácora y el desvinculo se escriben en la MISMA transacción: o queda
  // rastro y se suelta el vínculo, o no pasa nada.
  const { error: rpcErr } = await admin.rpc('purge_attachment_record', {
    p_ticket_id: ticketId,
    p_message_id: messageId,
    p_actor_id: viewer.id,
    p_media_path: path,
    p_reason: reason,
  })
  if (rpcErr) throw rpcErr

  const { error: sErr } = await admin.storage.from(MEDIA_BUCKET).remove([path])
  if (sErr) {
    throw new AttachmentError(
      'storage_delete_failed',
      'No se pudo eliminar el archivo del bucket',
      500,
    )
  }

  return { purged: true, ticket_id: ticket.id, message_id: messageId, path }
}

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
 * The FILE is served through the API and never straight from the browser:
 * the bucket `whatsapp-media` is private and the Storage policies for
 * `authenticated` were dropped, so the only way to read an object is a
 * signed URL that the API issues AFTER authorizing the caller.
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
  const admin = createSupabaseAdminClient()

  const { data: ticket, error: tErr } = await admin
    .from('tickets')
    .select('id, assigned_to')
    .eq('id', ticketId)
    .is('deleted_at', null)
    .maybeSingle<{ id: string; assigned_to: string | null }>()
  if (tErr) throw tErr
  if (!ticket) {
    throw new AttachmentError('ticket_not_found', 'El ticket no existe', 404)
  }

  if (isPrivileged(viewer)) return true
  if (ticket.assigned_to === viewer.id) return true

  const { data: attached, error: aErr } = await admin
    .from('ticket_message_attachments')
    .select('message_id')
    .eq('ticket_id', ticketId)
  if (aErr) throw aErr
  const messageIds = (attached ?? []).map((r) => r.message_id as string)
  if (messageIds.length === 0) return false

  const { data: messages, error: mErr } = await admin
    .from('messages')
    .select('conversation_id')
    .in('id', messageIds)
  if (mErr) throw mErr
  const conversationIds = [
    ...new Set((messages ?? []).map((m) => m.conversation_id as string)),
  ]
  if (conversationIds.length === 0) return false

  const { data: owned, error: oErr } = await admin
    .from('conversations')
    .select('id')
    .in('id', conversationIds)
    .eq('assigned_agent_id', viewer.id)
  if (oErr) throw oErr
  return (owned ?? []).length > 0
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

export async function listTicketAttachments(
  ticketId: string,
  viewer: AttachmentViewer,
): Promise<AttachedMessage[]> {
  const admin = createSupabaseAdminClient()
  await assertTicketAttachmentAccess(viewer, ticketId)

  const { data, error } = await admin
    .from('ticket_message_attachments')
    .select(
      'ticket_id, message_id, attached_by, attached_at, note, ' +
        'messages!ticket_message_attachments_message_id_fkey(body, direction, created_at)',
    )
    .eq('ticket_id', ticketId)
    .order('attached_at', { ascending: false })

  if (error) throw error

  return ((data ?? []) as unknown as Array<{
    ticket_id: string
    message_id: string
    attached_by: string | null
    attached_at: string
    note: string | null
    messages: { body: string | null; direction: 'in' | 'out'; created_at: string } | null
  }>).map((row) => ({
    message_id: row.message_id,
    ticket_id: row.ticket_id,
    body: row.messages?.body ?? null,
    direction: row.messages?.direction ?? 'in',
    created_at: row.messages?.created_at ?? row.attached_at,
    attached_by: row.attached_by,
    attached_at: row.attached_at,
    note: row.note,
  }))
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

/**
 * Unpin a message and delete the file that came with it.
 *
 * The row in `ticket_message_attachments` disappears; the message in
 * `messages` does not. The OBJECT disappears too, because leaving it in the
 * bucket would keep the file downloadable by anybody who knows the path.
 */
export async function detachMessage(
  ticketId: string,
  messageId: string,
  viewer: AttachmentViewer,
): Promise<{ detached: true; file_deleted: boolean }> {
  const admin = createSupabaseAdminClient()

  await assertTicketAttachmentAccess(viewer, ticketId)

  const { data: attachment, error: aErr } = await admin
    .from('ticket_message_attachments')
    .select('message_id')
    .eq('ticket_id', ticketId)
    .eq('message_id', messageId)
    .maybeSingle<{ message_id: string }>()
  if (aErr) throw aErr
  if (!attachment) {
    throw new AttachmentError(
      'attachment_not_found',
      'El mensaje no está adjunto a este ticket',
      404,
    )
  }

  const { data: message, error: mErr } = await admin
    .from('messages')
    .select('id, media_urls')
    .eq('id', messageId)
    .maybeSingle<{ id: string; media_urls: unknown }>()
  if (mErr) throw mErr

  const { error } = await admin
    .from('ticket_message_attachments')
    .delete()
    .eq('ticket_id', ticketId)
    .eq('message_id', messageId)
  if (error) throw error

  let fileDeleted = false
  for (const path of ownedMediaPaths(message?.media_urls)) {
    const { error: sErr } = await admin.storage.from(MEDIA_BUCKET).remove([path])
    if (sErr) throw sErr
    fileDeleted = true
  }

  return { detached: true, file_deleted: fileDeleted }
}

/**
 * One attachment with a signed URL for its file.
 *
 * The URL is issued only after the caller is authorized, and it expires in
 * five minutes: the browser never talks to Storage directly.
 */
export async function getTicketAttachment(
  ticketId: string,
  messageId: string,
  viewer: AttachmentViewer,
): Promise<{
  message_id: string
  ticket_id: string
  body: string | null
  direction: 'in' | 'out'
  created_at: string
  attached_by: string | null
  attached_at: string
  note: string | null
  media_url: string | null
}> {
  const admin = createSupabaseAdminClient()

  await assertTicketAttachmentAccess(viewer, ticketId)

  const { data, error } = await admin
    .from('ticket_message_attachments')
    .select(
      'ticket_id, message_id, attached_by, attached_at, note, ' +
        'messages!ticket_message_attachments_message_id_fkey(body, direction, created_at, media_urls)',
    )
    .eq('ticket_id', ticketId)
    .eq('message_id', messageId)
    .maybeSingle()
  if (error) throw error
  if (!data) {
    throw new AttachmentError(
      'attachment_not_found',
      'El mensaje no está adjunto a este ticket',
      404,
    )
  }

  const row = data as unknown as {
    ticket_id: string
    message_id: string
    attached_by: string | null
    attached_at: string
    note: string | null
    messages: {
      body: string | null
      direction: 'in' | 'out'
      created_at: string
      media_urls: unknown
    } | null
  }

  let mediaUrl: string | null = null
  const [path] = ownedMediaPaths(row.messages?.media_urls)
  if (path) {
    const { data: signed, error: sErr } = await admin.storage
      .from(MEDIA_BUCKET)
      .createSignedUrl(path, 300)
    if (sErr) throw sErr
    mediaUrl = signed?.signedUrl ?? null
  }

  return {
    message_id: row.message_id,
    ticket_id: row.ticket_id,
    body: row.messages?.body ?? null,
    direction: row.messages?.direction ?? 'in',
    created_at: row.messages?.created_at ?? row.attached_at,
    attached_by: row.attached_by,
    attached_at: row.attached_at,
    note: row.note,
    media_url: mediaUrl,
  }
}

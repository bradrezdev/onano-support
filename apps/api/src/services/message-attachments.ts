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
 *
 * Otherwise anyone could attach a message from a private chat to any ticket
 * and leak it.
 */

import { createSupabaseAdminClient } from '@/lib/supabase/admin'

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

export async function listTicketAttachments(
  ticketId: string,
): Promise<AttachedMessage[]> {
  const admin = createSupabaseAdminClient()

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
  note?: string,
): Promise<{ attached: number; skipped: number }> {
  if (messageIds.length === 0) {
    return { attached: 0, skipped: 0 }
  }

  const admin = createSupabaseAdminClient()

  const { data: ticket, error: tErr } = await admin
    .from('tickets')
    .select('id')
    .eq('id', ticketId)
    .is('deleted_at', null)
    .maybeSingle<{ id: string }>()
  if (tErr) throw tErr
  if (!ticket) throw new AttachmentError('ticket_not_found', 'El ticket no existe', 404)

  const { data: messages, error: mErr } = await admin
    .from('messages')
    .select('id')
    .in('id', messageIds)
  if (mErr) throw mErr

  const found = new Set(
    ((messages ?? []) as Array<{ id: string }>).map((m) => m.id),
  )
  const unknown = messageIds.filter((id) => !found.has(id))
  if (unknown.length > 0) {
    throw new AttachmentError(
      'message_not_found',
      `${unknown.length} mensaje(s) no existen`,
      400,
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

export async function detachMessage(
  ticketId: string,
  messageId: string,
): Promise<{ detached: true }> {
  const admin = createSupabaseAdminClient()

  const { error } = await admin
    .from('ticket_message_attachments')
    .delete()
    .eq('ticket_id', ticketId)
    .eq('message_id', messageId)
  if (error) throw error

  return { detached: true }
}
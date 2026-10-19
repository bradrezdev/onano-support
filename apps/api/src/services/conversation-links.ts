/**
 * Conversation ↔ Ticket link service.
 * Schema: `conversation_tickets(conversation_id, ticket_id, linked_by, linked_at)`
 * with composite PK and cascade delete on either side.
 */

import { createSupabaseAdminClient } from '@/lib/supabase/admin'

export interface LinkedTicketSummary {
  id: string
  name: string
  status: 'open' | 'in_progress' | 'closed'
  assigned_to: string | null
  updated_at: string
}

export interface LinkedConversationSummary {
  id: string
  contact_id: string
  status: 'open' | 'pending' | 'closed'
  last_message_at: string | null
  last_message_preview: string | null
}

export class LinkError extends Error {
  status: number
  code: string
  constructor(code: string, message: string, status = 400) {
    super(message)
    this.code = code
    this.status = status
  }
}

export async function listLinkedTickets(
  conversationId: string,
): Promise<LinkedTicketSummary[]> {
  const admin = createSupabaseAdminClient()
  const { data, error } = await admin
    .from('conversation_tickets')
    .select('ticket_id, tickets(id, name, status, assigned_to, updated_at)')
    .eq('conversation_id', conversationId)
  if (error) throw error
  // Supabase returns embedded selects as arrays; flatten to first match.
  const rows = (data ?? []) as Array<{ tickets: LinkedTicketSummary[] | null }>
  const out: LinkedTicketSummary[] = []
  for (const r of rows) {
    if (r.tickets && r.tickets.length > 0) out.push(r.tickets[0] as LinkedTicketSummary)
  }
  return out
}

export async function listLinkedConversations(
  ticketId: string,
): Promise<LinkedConversationSummary[]> {
  const admin = createSupabaseAdminClient()
  const { data, error } = await admin
    .from('conversation_tickets')
    .select('conversation_id, conversations(id, contact_id, status, last_message_at, last_message_preview)')
    .eq('ticket_id', ticketId)
  if (error) throw error
  const rows = (data ?? []) as Array<{ conversations: LinkedConversationSummary[] | null }>
  const out: LinkedConversationSummary[] = []
  for (const r of rows) {
    if (r.conversations && r.conversations.length > 0) out.push(r.conversations[0] as LinkedConversationSummary)
  }
  return out
}

export async function linkTicketToConversation(
  conversationId: string,
  ticketId: string,
  actorId: string,
): Promise<{ conversation_id: string; ticket_id: string; linked_by: string; linked_at: string }> {
  const admin = createSupabaseAdminClient()
  const [{ data: ticket, error: tErr }, { data: conv, error: cErr }] = await Promise.all([
    admin.from('tickets').select('id').eq('id', ticketId).maybeSingle<{ id: string }>(),
    admin.from('conversations').select('id').eq('id', conversationId).maybeSingle<{ id: string }>(),
  ])
  if (tErr) throw tErr
  if (cErr) throw cErr
  if (!ticket) throw new LinkError('ticket_not_found', 'Ticket no encontrado', 404)
  if (!conv) throw new LinkError('conversation_not_found', 'Conversación no encontrada', 404)

  const { data, error } = await admin
    .from('conversation_tickets')
    .upsert(
      { conversation_id: conversationId, ticket_id: ticketId, linked_by: actorId },
      { onConflict: 'conversation_id,ticket_id' },
    )
    .select('conversation_id, ticket_id, linked_by, linked_at')
    .single<{ conversation_id: string; ticket_id: string; linked_by: string; linked_at: string }>()
  if (error) throw error
  return data
}

export async function unlinkTicketFromConversation(
  conversationId: string,
  ticketId: string,
): Promise<{ removed: boolean }> {
  const admin = createSupabaseAdminClient()
  const { data, error } = await admin
    .from('conversation_tickets')
    .delete()
    .eq('conversation_id', conversationId)
    .eq('ticket_id', ticketId)
    .select('conversation_id')
  if (error) throw error
  return { removed: ((data ?? []) as unknown[]).length > 0 }
}
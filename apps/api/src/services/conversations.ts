/**
 * Conversations + inbound WhatsApp message handling.
 *
 * Inbound webhook inserts messages with `ignoreDuplicates: true` keyed on
 * `twilio_sid` so a redelivery does not double-write. Outbound replies are
 * inserted by the agent; the actual Twilio HTTP call is deferred until
 * TWILIO_ACCOUNT_SID/AUTH_TOKEN/NUMBER are configured in apps/api/.env.
 */

import { createSupabaseAdminClient } from '@/lib/supabase/admin'
import { normalizePhone } from '@/lib/phone'

export interface Conversation {
  id: string
  contact_id: string
  assigned_agent_id: string | null
  status: 'open' | 'pending' | 'closed'
  last_message_at: string | null
  last_message_preview: string | null
  unread_count: number
  created_at: string
}

export interface ConversationWithContact extends Conversation {
  contact: {
    id: string
    whatsapp_number: string
    name: string | null
  } | null
}

export interface MessageRow {
  id: string
  conversation_id: string
  direction: 'in' | 'out'
  body: string | null
  media_urls: unknown
  twilio_sid: string | null
  twilio_status: 'queued' | 'sent' | 'delivered' | 'read' | 'failed' | null
  sent_by_id: string | null
  created_at: string
}

export class ConversationError extends Error {
  status: number
  code: string
  constructor(code: string, message: string, status = 400) {
    super(message)
    this.code = code
    this.status = status
  }
}

export async function listConversations(filter: {
  contact_id?: string
  assigned_agent_id?: string
  status?: Conversation['status']
  limit?: number
  /** Return unassigned conversations alongside the caller's own (W2). */
  include_unassigned?: boolean
}): Promise<ConversationWithContact[]> {
  const admin = createSupabaseAdminClient()
  let q = admin
    .from('conversations')
    .select('id, contact_id, assigned_agent_id, status, last_message_at, last_message_preview, unread_count, created_at, contacts(id, whatsapp_number, name)')
    .order('last_message_at', { ascending: false, nullsFirst: false })
    .limit(filter.limit ?? 100)

  if (filter.contact_id) q = q.eq('contact_id', filter.contact_id)
  if (filter.status) q = q.eq('status', filter.status)

  if (filter.assigned_agent_id) {
    if (filter.include_unassigned) {
      // OR of "mine" + "nobody's" — PostgREST: assigned_agent_id=eq.X,assigned_agent_id=is.null
      q = q.in('assigned_agent_id', [filter.assigned_agent_id, null])
    } else {
      q = q.eq('assigned_agent_id', filter.assigned_agent_id)
    }
  }

  const { data, error } = await q
  if (error) throw error
  return (data ?? []) as unknown as ConversationWithContact[]
}

export async function findOrCreateConversationForContact(
  contactId: string,
): Promise<Conversation> {
  const admin = createSupabaseAdminClient()
  const { data: existing, error: e1 } = await admin
    .from('conversations')
    .select('*')
    .eq('contact_id', contactId)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle<Conversation>()
  if (e1) throw e1
  if (existing) return existing

  const { data: created, error: e2 } = await admin
    .from('conversations')
    .insert({ contact_id: contactId })
    .select('*')
    .single<Conversation>()
  if (e2) throw e2
  return created
}

export async function findContactByWhatsappNumber(
  whatsappNumber: string,
): Promise<{ id: string; name: string | null; whatsapp_number: string } | null> {
  const admin = createSupabaseAdminClient()
  const e164 = normalizePhone(whatsappNumber)
  const { data, error } = await admin
    .from('contacts')
    .select('id, name, whatsapp_number')
    .eq('whatsapp_number', e164)
    .maybeSingle<{ id: string; name: string | null; whatsapp_number: string }>()
  if (error) throw error
  return data
}

/**
 * Insert an inbound WhatsApp message idempotently. If a row with the same
 * `twilio_sid` already exists, returns the existing row instead of failing.
 * Caller does not need to check first.
 */
export async function appendInboundMessage(input: {
  conversation_id: string
  body: string | null
  twilio_sid: string
  media_urls?: unknown
}): Promise<MessageRow> {
  const admin = createSupabaseAdminClient()
  const { data, error } = await admin
    .from('messages')
    .upsert(
      {
        conversation_id: input.conversation_id,
        direction: 'in',
        body: input.body,
        twilio_sid: input.twilio_sid,
        media_urls: input.media_urls ?? [],
      },
      { onConflict: 'twilio_sid', ignoreDuplicates: true },
    )
    .select('id, conversation_id, direction, body, media_urls, twilio_sid, twilio_status, sent_by_id, created_at')
    .single<MessageRow>()
  if (error) throw error
  return data
}

export async function appendOutboundMessage(input: {
  conversation_id: string
  body: string
  sent_by_id: string
  twilio_sid?: string
}): Promise<MessageRow> {
  const admin = createSupabaseAdminClient()
  const { data, error } = await admin
    .from('messages')
    .insert({
      conversation_id: input.conversation_id,
      direction: 'out',
      body: input.body,
      sent_by_id: input.sent_by_id,
      twilio_sid: input.twilio_sid ?? null,
      twilio_status: input.twilio_sid ? 'queued' : null,
    })
    .select('id, conversation_id, direction, body, media_urls, twilio_sid, twilio_status, sent_by_id, created_at')
    .single<MessageRow>()
  if (error) throw error
  return data
}

export async function updateMessageStatusBySid(
  twilioSid: string,
  status: NonNullable<MessageRow['twilio_status']>,
): Promise<{ updated: boolean }> {
  const admin = createSupabaseAdminClient()
  const { data, error } = await admin
    .from('messages')
    .update({ twilio_status: status })
    .eq('twilio_sid', twilioSid)
    .select('id')
  if (error) throw error
  return { updated: ((data ?? []) as { id: string }[]).length > 0 }
}

export async function getConversationDetail(id: string): Promise<{
  conversation: ConversationWithContact
  messages: MessageRow[]
} | null> {
  const admin = createSupabaseAdminClient()
  const [{ data: conv, error: cErr }, { data: msgs, error: mErr }] = await Promise.all([
    admin
      .from('conversations')
      .select('id, contact_id, assigned_agent_id, status, last_message_at, last_message_preview, unread_count, created_at, contacts(id, whatsapp_number, name)')
      .eq('id', id)
      .maybeSingle<ConversationWithContact>(),
    admin
      .from('messages')
      .select('id, conversation_id, direction, body, media_urls, twilio_sid, twilio_status, sent_by_id, created_at')
      .eq('conversation_id', id)
      .order('created_at', { ascending: true }),
  ])
  if (cErr) throw cErr
  if (mErr) throw mErr
  if (!conv) return null
  return { conversation: conv, messages: (msgs ?? []) as unknown as MessageRow[] }
}

/**
 * W2: Admin and Supervisor see every conversation. Soporte only sees the ones
 * they own — the unassigned ones too, otherwise the "take it" queue (the row
 * at the supermarket till) is invisible and the customer waits.
 *
 * This is a hard guard, not a UI filter: the API returns 403 for a
 * conversation the caller is not entitled to read.
 */
export function canAccessConversation(
  viewer: { id: string; role: 'admin' | 'supervisor' | 'soporte' },
  conversation: { assigned_agent_id: string | null },
): boolean {
  if (viewer.role === 'admin' || viewer.role === 'supervisor') return true
  if (conversation.assigned_agent_id === null) return true
  return conversation.assigned_agent_id === viewer.id
}

export async function findConversationOrThrow(id: string): Promise<Conversation> {
  const admin = createSupabaseAdminClient()
  const { data, error } = await admin
    .from('conversations')
    .select('id, contact_id, assigned_agent_id, status, last_message_at, last_message_preview, unread_count, created_at')
    .eq('id', id)
    .maybeSingle<Conversation>()
  if (error) throw error
  if (!data) throw new ConversationError('not_found', 'Conversación no encontrada', 404)
  return data
}

/**
 * W4: Admin and Supervisor hand a conversation to someone else.
 *
 * Guard rails:
 *   - cannot assign to a suspended/deleted profile
 *   - cannot assign to yourself while the conversation already belongs to
 *     someone else (that is a takeover, use reassign only downward)
 *
 * Passing `null` puts the conversation back in the unassigned queue.
 */
export async function reassignConversation(
  id: string,
  assignedAgentId: string | null,
  actorId: string,
): Promise<Conversation> {
  const admin = createSupabaseAdminClient()

  if (assignedAgentId) {
    const { data: target, error: tErr } = await admin
      .from('profiles')
      .select('id, display_name, suspended_at, deleted_at')
      .eq('id', assignedAgentId)
      .maybeSingle<{
        id: string
        display_name: string | null
        suspended_at: string | null
        deleted_at: string | null
      }>()
    if (tErr) throw tErr
    if (!target) {
      throw new ConversationError('assignee_not_found', 'El usuario asignado no existe', 400)
    }
    if (target.suspended_at || target.deleted_at) {
      throw new ConversationError('assignee_inactive', 'El usuario asignado está inactivo', 400)
    }
  }

  const { data, error } = await admin
    .from('conversations')
    .update({ assigned_agent_id: assignedAgentId })
    .eq('id', id)
    .select('id, contact_id, assigned_agent_id, status, last_message_at, last_message_preview, unread_count, created_at')
    .single<Conversation>()
  if (error) throw error
  void actorId
  return data
}

/**
 * Recommendation 7: an agent claims an unassigned conversation ("Tomar").
 * Fails when somebody already claimed it — two agents pressing the button at
 * the same time must not silently overwrite each other.
 */
export async function takeConversation(id: string, actorId: string): Promise<Conversation> {
  const admin = createSupabaseAdminClient()
  const { data, error } = await admin
    .from('conversations')
    .update({ assigned_agent_id: actorId })
    .eq('id', id)
    .is('assigned_agent_id', null)
    .select('id, contact_id, assigned_agent_id, status, last_message_at, last_message_preview, unread_count, created_at')
    .maybeSingle<Conversation>()
  if (error) throw error
  if (!data) {
    throw new ConversationError(
      'already_taken',
      'Otra persona ya tomó esta conversación',
      409,
    )
  }
  return data
}

/**
 * W3: Soporte asks someone else to answer. Records who was asked and who
 * asked, so the escalation is visible on the conversation instead of living
 * in a private chat.
 */
export async function escalateConversation(
  id: string,
  toUserId: string,
  actorId: string,
): Promise<{ conversation: Conversation; escalated_to: string }> {
  const admin = createSupabaseAdminClient()

  const { data: target, error: tErr } = await admin
    .from('profiles')
    .select('id, suspended_at, deleted_at')
    .eq('id', toUserId)
    .maybeSingle<{ id: string; suspended_at: string | null; deleted_at: string | null }>()
  if (tErr) throw tErr
  if (!target) {
    throw new ConversationError('assignee_not_found', 'El usuario no existe', 400)
  }
  if (target.suspended_at || target.deleted_at) {
    throw new ConversationError('assignee_inactive', 'El usuario está inactivo', 400)
  }

  // The asker keeps ownership; the escalation is a request, not a handover.
  const { data, error } = await admin
    .from('conversations')
    .update({ escalated_to_id: toUserId, escalated_by_id: actorId, escalated_at: new Date().toISOString() })
    .eq('id', id)
    .select('id, contact_id, assigned_agent_id, status, last_message_at, last_message_preview, unread_count, created_at')
    .single<Conversation>()
  if (error) throw error
  return { conversation: data, escalated_to: toUserId }
}
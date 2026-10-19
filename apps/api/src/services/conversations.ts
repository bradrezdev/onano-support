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
}): Promise<ConversationWithContact[]> {
  const admin = createSupabaseAdminClient()
  let q = admin
    .from('conversations')
    .select('id, contact_id, assigned_agent_id, status, last_message_at, last_message_preview, unread_count, created_at, contacts(id, whatsapp_number, name)')
    .order('last_message_at', { ascending: false, nullsFirst: false })
    .limit(filter.limit ?? 100)

  if (filter.contact_id) q = q.eq('contact_id', filter.contact_id)
  if (filter.assigned_agent_id) q = q.eq('assigned_agent_id', filter.assigned_agent_id)
  if (filter.status) q = q.eq('status', filter.status)

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
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
  /**
   * Bumped on every holder change. The client sends the version it saw and
   * the API rejects a stale one instead of overwriting somebody else's work.
   */
  assignment_version: number
}

export interface ConversationWithContact extends Conversation {
  contact: {
    id: string
    whatsapp_number: string
    name: string | null
  } | null
}

/** La fila que devuelve `reassign_conversation` (ver la migración). */
export interface ReassignedConversation {
  conversation_id: string
  contact_id: string
  assigned_agent_id: string | null
  status: Conversation['status']
  last_message_at: string | null
  last_message_preview: string | null
  unread_count: number
  created_at: string
  assignment_version: number
  previous_assignee_id: string | null
  changed_at: string
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

/**
 * The errors the authorization functions in the database raise. The SQLSTATE
 * is the contract: the API turns it into an HTTP status and a stable code.
 * The raised text equals the code, so the mapping survives even if the
 * SQLSTATE does not reach the client.
 */
const RPC_ERRORS: Record<string, { code: string; message: string; status: number }> = {
  C0001: {
    code: 'reason_required',
    message: 'Indica el motivo de la transferencia',
    status: 400,
  },
  C0002: {
    code: 'version_required',
    message: 'Falta la versión vigente de la conversación',
    status: 400,
  },
  C0003: {
    code: 'conversation_not_found',
    message: 'Conversación no encontrada',
    status: 404,
  },
  C0004: {
    code: 'version_conflict',
    message: 'La conversación cambió mientras la transferías',
    status: 409,
  },
  C0005: {
    code: 'invalid_assignee',
    message: 'El usuario asignado no existe o está inactivo',
    status: 400,
  },
  C0006: { code: 'empty_body', message: 'El mensaje está vacío', status: 400 },
  C0007: { code: 'forbidden', message: 'El actor no es válido', status: 403 },
  C0008: {
    code: 'conversation_unassigned',
    message: 'La conversación no tiene titular: tómala antes de responder',
    status: 409,
  },
  C0009: {
    code: 'assignment_changed',
    message: 'Esta conversación cambió de titular: tu mensaje no se guardó',
    status: 409,
  },
  C0010: {
    code: 'already_taken',
    message: 'Otra persona ya tomó esta conversación',
    status: 409,
  },
}

function mapRpcError(error: { code?: string; message?: string }): ConversationError {
  const byState = error.code ? RPC_ERRORS[error.code] : undefined
  if (byState) return new ConversationError(byState.code, byState.message, byState.status)

  const text = (error.message ?? '').trim()
  const byText = Object.values(RPC_ERRORS).find((e) => e.code === text)
  if (byText) return new ConversationError(byText.code, byText.message, byText.status)

  if (error.code === '23505') {
    return new ConversationError('duplicate', 'Ese registro ya existe', 409)
  }
  return new ConversationError('db_error', text || 'Error de base de datos', 500)
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
    .select('id, contact_id, assigned_agent_id, status, last_message_at, last_message_preview, unread_count, created_at, assignment_version, contacts(id, whatsapp_number, name)')
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

/**
 * Persist an outbound reply.
 *
 * The write goes through `append_outbound_message` (SECURITY DEFINER) so the
 * assignment check and the insert happen in ONE transaction: if the chat
 * changed hands while the agent was typing, nothing is written and the caller
 * gets `assignment_changed`.
 */
export async function appendOutboundMessage(input: {
  conversation_id: string
  body: string
  sent_by_id: string
  twilio_sid?: string
}): Promise<MessageRow> {
  const admin = createSupabaseAdminClient()
  const { data, error } = await admin.rpc('append_outbound_message', {
    p_conversation_id: input.conversation_id,
    p_actor_id: input.sent_by_id,
    p_body: input.body,
    p_media_urls: [],
    p_twilio_sid: input.twilio_sid ?? null,
    p_twilio_status: input.twilio_sid ? 'queued' : null,
  })
  if (error) throw mapRpcError(error)

  const row = (Array.isArray(data) ? data[0] : data) as MessageRow | null
  if (!row) {
    throw new ConversationError('db_error', 'No se pudo guardar el mensaje', 500)
  }
  return row
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
      .select('id, contact_id, assigned_agent_id, status, last_message_at, last_message_preview, unread_count, created_at, assignment_version, contacts(id, whatsapp_number, name)')
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
  viewer: { id: string; role?: string | null; role_key?: string | null },
  conversation: { assigned_agent_id: string | null },
): boolean {
  // `role_key` es la verdad; `role` es la columna heredada.
  if (isPrivileged(viewer)) return true
  if (conversation.assigned_agent_id === null) return true
  return conversation.assigned_agent_id === viewer.id
}

/**
 * `role_key` is the truth; `role` is the legacy column. A custom role is not
 * privileged just because it was granted powerful permissions.
 */
export function isPrivileged(viewer: {
  role?: string | null
  role_key?: string | null
}): boolean {
  const key = viewer.role_key ?? viewer.role
  return key === 'admin' || key === 'supervisor'
}

/**
 * Who may WRITE in a conversation.
 *
 * Reading is broader than writing: an admin or supervisor reads every chat,
 * but writing follows the HOLDER. An unassigned chat has no holder — you have
 * to take it before answering.
 *
 * The check that actually decides lives in the database
 * (`append_outbound_message`), inside the same transaction as the insert.
 * This one is for the routes that need to answer before they write.
 */
export function canWriteConversation(
  viewer: { id: string; role?: string | null; role_key?: string | null },
  conversation: { assigned_agent_id: string | null },
): boolean {
  if (isPrivileged(viewer)) return true
  if (conversation.assigned_agent_id === null) return false
  return conversation.assigned_agent_id === viewer.id
}

export async function findConversationOrThrow(id: string): Promise<Conversation> {
  const admin = createSupabaseAdminClient()
  const { data, error } = await admin
    .from('conversations')
    .select('id, contact_id, assigned_agent_id, status, last_message_at, last_message_preview, unread_count, created_at, assignment_version')
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
 *   - the target must exist and be active
 *   - a REASON is mandatory: a handover without a reason is not auditable
 *   - the caller sends the version it saw; if the chat changed meanwhile the
 *     transfer is rejected (409) instead of overwriting the other change
 *
 * The change and its audit entry are written in ONE transaction by
 * `reassign_conversation` (SECURITY DEFINER): actor, previous holder, new
 * holder, reason and date. Passing `null` puts the conversation back in the
 * unassigned queue.
 */
export async function reassignConversation(
  id: string,
  assignedAgentId: string | null,
  actorId: string,
  reason: string,
  expectedVersion: number,
): Promise<Conversation> {
  const admin = createSupabaseAdminClient()

  const { data, error } = await admin.rpc('reassign_conversation', {
    p_conversation_id: id,
    p_actor_id: actorId,
    p_new_assignee_id: assignedAgentId,
    p_reason: reason,
    p_expected_version: expectedVersion,
  })
  if (error) throw mapRpcError(error)

  // La forma la define la función: sin un cast laxo, porque un cast que
  // promete campos que el RPC no devuelve esconde el error hasta el cliente.
  const row = (Array.isArray(data) ? data[0] : data) as ReassignedConversation | null
  if (!row) {
    throw new ConversationError('db_error', 'No se pudo transferir la conversación', 500)
  }
  return {
    id: row.conversation_id,
    contact_id: row.contact_id,
    assigned_agent_id: row.assigned_agent_id,
    status: row.status,
    last_message_at: row.last_message_at,
    last_message_preview: row.last_message_preview,
    unread_count: row.unread_count,
    created_at: row.created_at,
    assignment_version: row.assignment_version,
  }
}

/**
 * Recommendation 7: an agent claims an unassigned conversation ("Tomar").
 * Fails when somebody already claimed it — two agents pressing the button at
 * the same time must not silently overwrite each other. Taking also changes
 * the holder, so it bumps the version and leaves an audit entry.
 */
export async function takeConversation(id: string, actorId: string): Promise<Conversation> {
  const admin = createSupabaseAdminClient()

  const { data, error } = await admin.rpc('take_conversation', {
    p_conversation_id: id,
    p_actor_id: actorId,
  })
  if (error) throw mapRpcError(error)

  const row = (Array.isArray(data) ? data[0] : data) as Conversation | null
  if (!row) {
    throw new ConversationError('db_error', 'No se pudo tomar la conversación', 500)
  }
  return row
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
    .select('id, contact_id, assigned_agent_id, status, last_message_at, last_message_preview, unread_count, created_at, assignment_version')
    .single<Conversation>()
  if (error) throw error
  return { conversation: data, escalated_to: toUserId }
}
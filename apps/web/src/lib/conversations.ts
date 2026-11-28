/**
 * Conversation types and API client helpers (browser side).
 */

export type Role = 'admin' | 'supervisor' | 'soporte'

export interface ConversationContact {
  id: string
  whatsapp_number: string
  name: string | null
}

export interface Conversation {
  id: string
  contact_id: string
  assigned_agent_id: string | null
  status: 'open' | 'pending' | 'closed'
  last_message_at: string | null
  last_message_preview: string | null
  unread_count: number
  created_at: string
  contact: ConversationContact | null
  assignment_version: number
}

export interface ConversationMessage {
  id: string
  conversation_id: string
  direction: 'in' | 'out'
  body: string | null
  twilio_sid: string | null
  twilio_status: 'queued' | 'sent' | 'delivered' | 'read' | 'failed' | null
  sent_by_id: string | null
  created_at: string
}

export interface ConversationDetail {
  conversation: Conversation
  messages: ConversationMessage[]
}

/** Lightweight summary used by ticket↔conversation cross-links. */
export interface LinkedConversationSummary {
  id: string
  contact_id: string
  status: 'open' | 'pending' | 'closed'
  last_message_at: string | null
  last_message_preview: string | null
}

export function previewSnippet(text: string | null, max = 80): string {
  if (!text) return '(sin contenido)'
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine
}
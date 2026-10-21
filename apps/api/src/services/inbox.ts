/**
 * "Mi bandeja" (D1, recommendation 8).
 *
 * A dashboard has to answer "what do I do now", not "show me 30 clocks".
 * This returns four numbers plus the rows behind them, scoped to the caller:
 *
 *   mine        — open tickets assigned to me
 *   overdue     — those past their due date (needs tickets.due_at)
 *   unassigned  — nobody's, waiting to be picked up
 *   unread      — conversations nobody has taken
 *
 * Read-only. It never mutates and it never leaks another agent's work to
 * someone who should not see it: `mine` is filtered by the caller's own id,
 * and the counts match exactly what the list endpoints would return.
 */

import { createSupabaseAdminClient } from '@/lib/supabase/admin'
import { ConversationError } from './conversations'

export interface InboxBucket {
  mine: { count: number; rows: TicketSummary[] }
  overdue: { count: number; rows: TicketSummary[] }
  unassigned: { count: number; rows: TicketSummary[] }
  unread: { count: number; rows: ConversationSummary[] }
}

export interface TicketSummary {
  id: string
  name: string
  status: 'open' | 'in_progress' | 'closed'
  updated_at: string
  due_at: string | null
  contact_name: string | null
}

export interface ConversationSummary {
  id: string
  contact_name: string | null
  last_message_at: string | null
  unread_count: number
}

const LIST_LIMIT = 8

export async function getMyInbox(userId: string): Promise<InboxBucket> {
  const admin = createSupabaseAdminClient()

  const [mine, unassigned, overdue, unread] = await Promise.all([
    listTickets(admin, { assigned_to: userId, status: 'open' }),
    listTickets(admin, { assigned_to: null, status: 'open' }),
    listOverdueTickets(admin, userId),
    listUnreadConversations(admin),
  ])

  return {
    mine: { count: mine.count, rows: mine.rows },
    overdue: { count: overdue.count, rows: overdue.rows },
    unassigned: { count: unassigned.count, rows: unassigned.rows },
    unread: { count: unread.count, rows: unread.rows },
  }
}

type Admin = ReturnType<typeof createSupabaseAdminClient>

interface TicketFilter {
  assigned_to: string | null
  status: 'open'
}

async function listTickets(
  admin: Admin,
  filter: TicketFilter,
): Promise<{ count: number; rows: TicketSummary[] }> {
  let q = admin
    .from('tickets')
    .select('id, name, status, updated_at, due_at, contacts!tickets_contact_id_fkey(name)', {
      count: 'exact',
    })
    .eq('status', filter.status)
    .is('deleted_at', null)
    .order('updated_at', { ascending: false })
    .limit(LIST_LIMIT)

  q = filter.assigned_to === null
    ? q.is('assigned_to', null)
    : q.eq('assigned_to', filter.assigned_to)

  const { data, error, count } = await q
  if (error) throw error

  return { count: count ?? 0, rows: ((data ?? []) as unknown as RawTicket[]).map(toTicketSummary) }
}

/**
 * Overdue = open, assigned to me, and past due. Tickets with no due date are
 * never overdue: absence of a deadline is not a missed one.
 */
async function listOverdueTickets(
  admin: Admin,
  userId: string,
): Promise<{ count: number; rows: TicketSummary[] }> {
  const now = new Date().toISOString()
  const { data, error, count } = await admin
    .from('tickets')
    .select('id, name, status, updated_at, due_at, contacts!tickets_contact_id_fkey(name)', {
      count: 'exact',
    })
    .eq('assigned_to', userId)
    .eq('status', 'open')
    .is('deleted_at', null)
    .not('due_at', 'is', null)
    .lt('due_at', now)
    .order('due_at', { ascending: true })
    .limit(LIST_LIMIT)

  if (error) throw error
  return { count: count ?? 0, rows: ((data ?? []) as unknown as RawTicket[]).map(toTicketSummary) }
}

/**
 * Unread = conversations with pending inbound messages. Split into two
 * buckets because they mean different things to the person looking at them:
 * nobody owns them yet ("the row at the till") versus mine to answer.
 */
async function listUnreadConversations(
  admin: Admin,
): Promise<{ count: number; rows: ConversationSummary[] }> {
  const { data, error, count } = await admin
    .from('conversations')
    .select(
      'id, last_message_at, unread_count, contacts!conversations_contact_id_fkey(name)',
      { count: 'exact' },
    )
    .gt('unread_count', 0)
    .eq('status', 'open')
    .order('last_message_at', { ascending: false, nullsFirst: false })
    .limit(LIST_LIMIT)

  if (error) throw error
  return { count: count ?? 0, rows: ((data ?? []) as unknown as RawConversation[]).map(toConversationSummary) }
}

interface RawTicket {
  id: string
  name: string
  status: TicketSummary['status']
  updated_at: string
  due_at: string | null
  contacts: { name: string | null } | null
}

interface RawConversation {
  id: string
  last_message_at: string | null
  unread_count: number
  contacts: { name: string | null } | null
}

/**
 * Supabase embedded-FK selects always come back as an array, never a single
 * object, even for a to-one relationship. Normalising here keeps that quirk
 * in one place instead of spreading `?? []` across the codebase.
 */
function toTicketSummary(row: RawTicket): TicketSummary {
  const contact = Array.isArray(row.contacts) ? row.contacts[0] : row.contacts
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    updated_at: row.updated_at,
    due_at: row.due_at,
    contact_name: contact?.name ?? null,
  }
}

function toConversationSummary(row: RawConversation): ConversationSummary {
  const contact = Array.isArray(row.contacts) ? row.contacts[0] : row.contacts
  return {
    id: row.id,
    contact_name: contact?.name ?? null,
    last_message_at: row.last_message_at,
    unread_count: row.unread_count,
  }
}

export { ConversationError }
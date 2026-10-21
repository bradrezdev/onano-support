/**
 * Audit trail (A1 + recommendation 4).
 *
 * Reads ticket_history — the append-only log every mutation already writes —
 * and adds the conversation side, which has no history table yet.
 *
 * This module is READ-ONLY by construction: there is no write function here.
 * The black box works only if nobody can alter it, so writes go straight to
 * ticket_history from the services that own the mutation, and there is no
 * exported path to edit or delete an entry.
 */

import { createSupabaseAdminClient } from '@/lib/supabase/admin'

export type AuditAction =
  | 'created'
  | 'assigned'
  | 'reassigned'
  | 'category_changed'
  | 'theme_changed'
  | 'flow_changed'
  | 'status_changed'
  | 'closed'
  | 'reopened'
  | 'trashed'
  | 'restored'

export type AuditScope = 'ticket' | 'conversation'

export interface AuditEntry {
  id: string
  scope: AuditScope
  action: string
  actor_id: string
  actor_name: string | null
  actor_role: string
  target_id: string
  target_label: string | null
  from_value: unknown
  to_value: unknown
  created_at: string
}

/**
 * A1 only cares about what Supervisores and Soporte did. Admin moves are
 * excluded: the page exists to watch the team, not to watch yourself.
 */
const WATCHED_ROLES = ['supervisor', 'soporte']

export async function listAuditEntries(filter: {
  action?: AuditAction
  actor_id?: string
  scope?: AuditScope
  page?: number
  limit?: number
}): Promise<AuditEntry[]> {
  const admin = createSupabaseAdminClient()
  const page = filter.page ?? 1
  const limit = filter.limit ?? 50
  const scope = filter.scope ?? 'ticket'

  if (scope === 'conversation') {
    return listConversationAudit(filter, page, limit)
  }

  let q = admin
    .from('ticket_history')
    .select(
      'id, ticket_id, action, actor_id, from_value, to_value, created_at, ' +
        'profiles!ticket_history_actor_id_fkey(id, display_name, role), ' +
        'tickets!ticket_history_ticket_id_fkey(id, name)',
    )
    .in('profiles.role', WATCHED_ROLES)
    .order('created_at', { ascending: false })
    .range((page - 1) * limit, page * limit - 1)

  if (filter.action) q = q.eq('action', filter.action)
  if (filter.actor_id) q = q.eq('actor_id', filter.actor_id)

  const { data, error } = await q
  if (error) throw error

  return ((data ?? []) as unknown as TicketHistoryJoined[]).map(toAuditEntry)
}

interface TicketHistoryJoined {
  id: string
  ticket_id: string
  action: string
  actor_id: string
  from_value: unknown
  to_value: unknown
  created_at: string
  profiles: { id: string; display_name: string | null; role: string } | null
  tickets: { id: string; name: string } | null
}

/**
 * Conversations have no history table, so the audit synthesizes entries from
 * the current state: who owns it and whether an escalation is pending. It is
 * a snapshot, not a change log — the shape differs from ticket_history on
 * purpose so nobody reads it as one.
 */
async function listConversationAudit(
  filter: { action?: AuditAction; actor_id?: string },
  page: number,
  limit: number,
): Promise<AuditEntry[]> {
  const admin = createSupabaseAdminClient()
  let q = admin
    .from('conversations')
    .select(
      'id, assigned_agent_id, escalated_to_id, escalated_by_id, escalated_at, created_at, ' +
        'profiles!conversations_assigned_agent_id_fkey(id, display_name, role), ' +
        'contacts!conversations_contact_id_fkey(whatsapp_number, name)',
    )
    .order('last_message_at', { ascending: false, nullsFirst: false })
    .range((page - 1) * limit, page * limit - 1)

  const { data, error } = await q
  if (error) throw error

  const rows = (data ?? []) as unknown as ConversationJoined[]

  return rows.flatMap<AuditEntry>((row) => {
    const owner = row.profiles
    const contact = row.contacts
    const label = contact?.name ?? contact?.whatsapp_number ?? row.id
    const out: AuditEntry[] = []

    if (owner && WATCHED_ROLES.includes(owner.role)) {
      out.push({
        id: `${row.id}:owned`,
        scope: 'conversation',
        action: 'assigned',
        actor_id: owner.id,
        actor_name: owner.display_name,
        actor_role: owner.role,
        target_id: row.id,
        target_label: label,
        from_value: null,
        to_value: { assigned_agent_id: owner.id },
        created_at: row.created_at,
      })
    }

    if (row.escalated_to_id) {
      out.push({
        id: `${row.id}:escalated`,
        scope: 'conversation',
        action: 'reassigned',
        actor_id: row.escalated_by_id ?? '',
        actor_name: null,
        actor_role: 'soporte',
        target_id: row.id,
        target_label: label,
        from_value: null,
        to_value: { escalated_to_id: row.escalated_to_id },
        created_at: row.escalated_at ?? row.created_at,
      })
    }

    return out
  })
}

interface ConversationJoined {
  id: string
  assigned_agent_id: string | null
  escalated_to_id: string | null
  escalated_by_id: string | null
  escalated_at: string | null
  created_at: string
  profiles: { id: string; display_name: string | null; role: string } | null
  contacts: { whatsapp_number: string; name: string | null } | null
}

function toAuditEntry(row: TicketHistoryJoined): AuditEntry {
  return {
    id: row.id,
    scope: 'ticket',
    action: row.action,
    actor_id: row.actor_id,
    actor_name: row.profiles?.display_name ?? null,
    actor_role: row.profiles?.role ?? 'unknown',
    target_id: row.ticket_id,
    target_label: row.tickets?.name ?? null,
    from_value: row.from_value,
    to_value: row.to_value,
    created_at: row.created_at,
  }
}
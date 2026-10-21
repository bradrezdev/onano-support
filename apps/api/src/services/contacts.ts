/**
 * Client record / ficha (C2).
 *
 * One request answers "who is this person and what happened with them":
 * their tickets, the ones flagged as major incidents, their conversations,
 * and the themes their tickets touched.
 *
 * Four queries in parallel instead of the SPA downloading every ticket and
 * filtering in the browser — that is the difference between a ficha that
 * loads instantly and one that loads when the ticket table grows.
 */

import { createSupabaseAdminClient } from '@/lib/supabase/admin'

export interface ContactDetail {
  contact: {
    id: string
    whatsapp_number: string
    name: string | null
    email: string | null
    country: string | null
    country_code: string | null
    profile_pic_url: string | null
    created_at: string
  }
  tickets: TicketRow[]
  major_incidents: TicketRow[]
  conversations: ConversationRow[]
  themes: ThemeTouch[]
  counts: {
    tickets_total: number
    tickets_open: number
    major_total: number
    conversations_total: number
  }
}

export interface TicketRow {
  id: string
  name: string
  status: 'open' | 'in_progress' | 'closed'
  priority: string | null
  is_major: boolean
  due_at: string | null
  updated_at: string
  category_name: string | null
  theme_name: string | null
}

export interface ConversationRow {
  id: string
  status: string
  last_message_at: string | null
  last_message_preview: string | null
  unread_count: number
}

export interface ThemeTouch {
  theme_id: string
  theme_name: string
  ticket_count: number
}

export class ContactNotFoundError extends Error {
  constructor() {
    super('Contact not found')
  }
}

export async function getContactDetail(id: string): Promise<ContactDetail | null> {
  const admin = createSupabaseAdminClient()

  const [contactRes, ticketsRes, conversationsRes] = await Promise.all([
    admin
      .from('contacts')
      .select('id, whatsapp_number, name, email, country, country_code, profile_pic_url, created_at')
      .eq('id', id)
      .is('deleted_at', null)
      .maybeSingle<ContactDetail['contact']>(),

    admin
      .from('tickets')
      .select(
        'id, name, status, priority, is_major, due_at, updated_at, ' +
          'categories!tickets_category_id_fkey(name), ' +
          'themes!tickets_theme_id_fkey(name)',
      )
      .eq('contact_id', id)
      .is('deleted_at', null)
      .order('updated_at', { ascending: false }),

    admin
      .from('conversations')
      .select('id, status, last_message_at, last_message_preview, unread_count')
      .eq('contact_id', id)
      .order('last_message_at', { ascending: false, nullsFirst: false }),
  ])

  if (contactRes.error) throw contactRes.error
  if (ticketsRes.error) throw ticketsRes.error
  if (conversationsRes.error) throw conversationsRes.error

  const contact = contactRes.data
  if (!contact) return null

  const tickets = ((ticketsRes.data ?? []) as unknown as RawTicket[]).map(toTicketRow)
  const conversations = (
    (conversationsRes.data ?? []) as unknown as Array<{
      id: string
      status: string
      last_message_at: string | null
      last_message_preview: string | null
      unread_count: number | null
    }>
  ).map((c) => ({
    id: c.id,
    status: c.status,
    last_message_at: c.last_message_at,
    last_message_preview: c.last_message_preview,
    unread_count: c.unread_count ?? 0,
  }))

  return {
    contact,
    tickets,
    major_incidents: tickets.filter((t) => t.is_major),
    conversations,
    themes: countByTheme(tickets),
    counts: {
      tickets_total: tickets.length,
      tickets_open: tickets.filter((t) => t.status !== 'closed').length,
      major_total: tickets.filter((t) => t.is_major).length,
      conversations_total: conversations.length,
    },
  }
}

/**
 * The theme history: which themes this client's tickets have covered, most
 * used first. That is what "historial de temas" means in C2 — not a raw
 * chronological list, but the pattern across time.
 */
function countByTheme(tickets: TicketRow[]): ThemeTouch[] {
  const map = new Map<string, ThemeTouch>()
  for (const t of tickets) {
    if (!t.theme_name) continue
    const existing = map.get(t.theme_name)
    if (existing) {
      existing.ticket_count += 1
    } else {
      map.set(t.theme_name, {
        theme_id: t.theme_name,
        theme_name: t.theme_name,
        ticket_count: 1,
      })
    }
  }
  return [...map.values()].sort((a, b) => b.ticket_count - a.ticket_count)
}

interface RawTicket {
  id: string
  name: string
  status: TicketRow['status']
  priority: string | null
  is_major: boolean
  due_at: string | null
  updated_at: string
  categories: { name: string | null } | { name: string | null }[] | null
  themes: { name: string | null } | { name: string | null }[] | null
}

/**
 * Supabase embedded-FK selects come back as an array even for a to-one
 * relation. Normalising both shapes here keeps the caller from having to
 * remember which one arrived.
 */
function toTicketRow(row: RawTicket): TicketRow {
  const category = Array.isArray(row.categories) ? row.categories[0] : row.categories
  const theme = Array.isArray(row.themes) ? row.themes[0] : row.themes
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    priority: row.priority,
    is_major: row.is_major ?? false,
    due_at: row.due_at,
    updated_at: row.updated_at,
    category_name: category?.name ?? null,
    theme_name: theme?.name ?? null,
  }
}
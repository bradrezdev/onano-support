import { NextResponse } from 'next/server'
import { requirePermission } from '@/lib/auth'
import { getQuery } from '@/lib/validate'
import { createSupabaseAdminClient } from '@/lib/supabase/admin'

interface TicketSearchHit {
  id: string
  name: string
  status: 'open' | 'in_progress' | 'closed'
  contact_id: string
  contact_email: string | null
  contact_name: string | null
  contact_country: string | null
  assigned_to: string | null
  theme_id: string | null
  flow_id: string | null
  created_at: string
  updated_at: string
}

export async function GET(request: Request) {
  const auth = await requirePermission(['ticket.read'], request)
  if ('error' in auth) return auth.error

  const q = getQuery<{ q?: string; limit?: number }>(request, {
    q: (v) => v,
    limit: (v) => Math.min(50, Math.max(1, parseInt(v, 10) || 25)),
  })

  const query = q.q?.trim() ?? ''
  const limit = q.limit ?? 25
  if (!query) return NextResponse.json({ data: [] })

  const admin = createSupabaseAdminClient()
  const pattern = `%${query}%`

  // 1) Find contact ids matching email/name/country.
  const { data: contacts, error: cErr } = await admin
    .from('contacts')
    .select('id')
    .or(`email.ilike.${pattern},name.ilike.${pattern},country.ilike.${pattern}`)
    .limit(limit)
  if (cErr) throw cErr
  const contactIds = ((contacts ?? []) as { id: string }[]).map((c) => c.id)

  // 2) Find tickets by name OR by one of those contact ids, join contact.
  const ors = [`name.ilike.${pattern}`]
  if (contactIds.length > 0) {
    ors.push(`contact_id.in.(${contactIds.join(',')})`)
  }
  const { data: tickets, error: tErr } = await admin
    .from('tickets')
    .select(
      'id, name, status, contact_id, assigned_to, theme_id, flow_id, created_at, updated_at, contact:contacts(email, name, country)',
    )
    .or(ors.join(','))
    .order('updated_at', { ascending: false })
    .limit(limit)
  if (tErr) throw tErr

  const hits: TicketSearchHit[] = ((tickets ?? []) as unknown as Parameters<typeof buildHit>[0][]).map((row) =>
    buildHit(row),
  )
  return NextResponse.json({ data: hits })
}

function buildHit(row: {
  id: string
  name: string
  status: 'open' | 'in_progress' | 'closed'
  contact_id: string
  assigned_to: string | null
  theme_id: string | null
  flow_id: string | null
  created_at: string
  updated_at: string
  contact: { email: string | null; name: string | null; country: string | null } | { email: string | null; name: string | null; country: string | null }[] | null
}): TicketSearchHit {
  const c = Array.isArray(row.contact) ? row.contact[0] ?? null : row.contact
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    contact_id: row.contact_id,
    contact_email: c?.email ?? null,
    contact_name: c?.name ?? null,
    contact_country: c?.country ?? null,
    assigned_to: row.assigned_to,
    theme_id: row.theme_id,
    flow_id: row.flow_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

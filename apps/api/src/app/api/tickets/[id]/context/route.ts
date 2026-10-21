import { NextResponse } from 'next/server'
import { requirePermission } from '@/lib/auth'
import { createSupabaseAdminClient } from '@/lib/supabase/admin'

type Params = { params: Promise<{ id: string }> }

export interface NamedRef {
  id: string
  name: string
}

export interface PersonRef {
  id: string
  display_name: string | null
  role_key: string | null
}

/**
 * GET /api/tickets/:id/context — resolve the ticket's foreign keys to labels.
 *
 * The ticket row stores six uuids (contact, category, assignee, creator,
 * project, stage) and none of them carry meaning to a reader. Rendering
 * `contact_id.slice(0,8)` is not a fix, it is a placeholder that got promoted
 * to a feature. This resolves them in one request instead of six.
 *
 * Every lookup is independent and failure-tolerant: a deleted category yields
 * `null` rather than a 500, because the ticket is still readable and its
 * remaining labels are still worth showing.
 */
export async function GET(request: Request, ctx: Params) {
  const auth = await requirePermission(['ticket.read'], request)
  if ('error' in auth) return auth.error
  const { id } = await ctx.params

  const admin = createSupabaseAdminClient()

  const { data: ticket, error: tErr } = await admin
    .from('tickets')
    .select('id, contact_id, category_id, assigned_to, created_by, theme_id, flow_id')
    .eq('id', id)
    .is('deleted_at', null)
    .maybeSingle<{
      id: string
      contact_id: string
      category_id: string
      assigned_to: string | null
      created_by: string
      theme_id: string | null
      flow_id: string | null
    }>()
  if (tErr) {
    return NextResponse.json(
      { code: 'db_error', error: 'db_error', message: tErr.message },
      { status: 500 },
    )
  }
  if (!ticket) {
    return NextResponse.json(
      { code: 'not_found', error: 'not_found', message: 'Ticket not found' },
      { status: 404 },
    )
  }

  // Every id is known to be a uuid already (they came from a uuid column), so
  // an empty list is the only case worth short-circuiting.
  const personIds = [ticket.created_by, ticket.assigned_to].filter(
    (v): v is string => !!v,
  )
  const personIdsParam = personIds.length > 0 ? personIds : ['00000000-0000-0000-0000-000000000000']

  const [clientRes, catRes, personRes, themeRes, flowRes] = await Promise.all([
    admin
      .from('contacts')
      .select('id, name')
      .eq('id', ticket.contact_id)
      .maybeSingle<NamedRef>(),
    admin
      .from('categories')
      .select('id, name')
      .eq('id', ticket.category_id)
      .maybeSingle<NamedRef>(),
    admin
      .from('profiles')
      .select('id, display_name, role_key')
      .in('id', personIdsParam)
      .then((r) => ({ data: r.data as PersonRef[] | null, error: r.error })),
    ticket.theme_id
      ? admin
          .from('themes')
          .select('id, name')
          .eq('id', ticket.theme_id)
          .maybeSingle<NamedRef>()
      : Promise.resolve({ data: null, error: null }),
    ticket.flow_id
      ? admin
          .from('flows')
          .select('id, name')
          .eq('id', ticket.flow_id)
          .maybeSingle<NamedRef>()
      : Promise.resolve({ data: null, error: null }),
  ])

  // A missing label is not an error worth failing the whole page over.
  for (const r of [clientRes, catRes, personRes, themeRes, flowRes]) {
    if (r.error) {
      return NextResponse.json(
        { code: 'db_error', error: 'db_error', message: r.error.message },
        { status: 500 },
      )
    }
  }

  const peopleById = new Map((personRes.data ?? []).map((p) => [p.id, p]))

  return NextResponse.json({
    data: {
      client: clientRes.data ?? null,
      category: catRes.data ?? null,
      assignee: ticket.assigned_to ? (peopleById.get(ticket.assigned_to) ?? null) : null,
      creator: peopleById.get(ticket.created_by) ?? null,
      project: themeRes.data ?? null,
      stage: flowRes.data ?? null,
    },
  })
}
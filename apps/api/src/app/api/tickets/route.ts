import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requirePermission } from '@/lib/auth'
import { parseJson, getQuery } from '@/lib/validate'
import { createSupabaseAdminClient } from '@/lib/supabase/admin'
import { createTicket, TicketValidationError } from '@/services/tickets'

const TicketCreateBody = z.object({
  contact_id: z.string().uuid(),
  category_id: z.string().uuid(),
  name: z.string().min(1).max(200),
  description: z.unknown(),
  assigned_to: z.string().uuid().nullable().optional(),
  theme_id: z.string().uuid().nullable().optional(),
  flow_id: z.string().uuid().nullable().optional(),
})

export async function GET(request: Request) {
  const auth = await requirePermission(['ticket.read'], request)
  if ('error' in auth) return auth.error

  const q = getQuery<{
    status?: 'open' | 'in_progress' | 'closed'
    assigned_to?: string
    category_id?: string
    theme_id?: string
    flow_id?: string
    contact_id?: string
    trashed?: boolean
    /** Only tickets past their due date. NULL due_at is never overdue. */
    overdue?: boolean
    priority?: string
    page?: number
    limit?: number
  }>(request, {
    page: (v) => Math.max(1, parseInt(v, 10) || 1),
    limit: (v) => Math.min(100, Math.max(1, parseInt(v, 10) || 50)),
    trashed: (v) => v === '1' || v === 'true',
    overdue: (v) => v === '1' || v === 'true',
  })

  const page = q.page ?? 1
  const limit = q.limit ?? 50
  const admin = createSupabaseAdminClient()
  let query = admin
    .from('tickets')
    .select('id, contact_id, category_id, assigned_to, theme_id, flow_id, name, status, priority, due_at, created_at, updated_at, closed_at, deleted_at')
    .order('updated_at', { ascending: false })
    .range((page - 1) * limit, page * limit - 1)

  // The trash is a separate axis from status: live tickets hide trashed ones
  // and vice versa, so a trashed ticket never shows up in a working list.
  query = q.trashed
    ? query.not('deleted_at', 'is', null)
    : query.is('deleted_at', null)

  // "assigned_to=me" and "assigned_to=none" are the two shorthands the
  // dashboard tiles link to; a raw uuid still works for anything else.
  if (q.assigned_to === 'me') query = query.eq('assigned_to', auth.user.id)
  else if (q.assigned_to === 'none') query = query.is('assigned_to', null)
  else if (q.assigned_to) query = query.eq('assigned_to', q.assigned_to)

  if (q.status) query = query.eq('status', q.status)
  if (q.category_id) query = query.eq('category_id', q.category_id)
  if (q.theme_id) query = query.eq('theme_id', q.theme_id)
  if (q.flow_id) query = query.eq('flow_id', q.flow_id)
  if (q.contact_id) query = query.eq('contact_id', q.contact_id)

  // Absence of a deadline is not a missed one: `not(is null)` is what keeps
  // undated tickets out of the "vencido" bucket.
  if (q.overdue) {
    query = query.not('due_at', 'is', null).lt('due_at', new Date().toISOString())
  }

  const { data, error } = await query
  if (error) {
    return NextResponse.json(
      { code: 'db_error', error: 'db_error', message: error.message },
      { status: 500 },
    )
  }
  return NextResponse.json({ data: data ?? [] })
}

export async function POST(request: Request) {
  const auth = await requirePermission(['ticket.create'], request)
  if ('error' in auth) return auth.error

  const parsed = await parseJson(request, TicketCreateBody)
  if ('error' in parsed) return parsed.error

  try {
    const ticket = await createTicket(parsed.data, auth.user.id)
    return NextResponse.json({ data: ticket }, { status: 201 })
  } catch (err) {
    if (err instanceof TicketValidationError) {
      return NextResponse.json(
        { code: err.code, error: err.code, message: err.message },
        { status: err.status },
      )
    }
    const e = err as { code?: string; message?: string }
    if (e.code === '23503') {
      return NextResponse.json(
        { code: 'invalid_fk', error: 'invalid_fk', message: 'contact_id or category_id does not exist' },
        { status: 400 },
      )
    }
    return NextResponse.json(
      { code: 'db_error', error: 'db_error', message: e.message ?? 'Unknown error' },
      { status: 500 },
    )
  }
}

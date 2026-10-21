import { NextResponse } from 'next/server'
import { requirePermission } from '@/lib/auth'
import { getQuery } from '@/lib/validate'
import { createSupabaseAdminClient } from '@/lib/supabase/admin'

/**
 * GET /api/tickets/trash — list trashed tickets.
 *
 * Requires `ticket.delete`: the trash only makes sense to whoever is allowed
 * to fill it.
 */
export async function GET(request: Request) {
  const auth = await requirePermission(['ticket.delete'], request)
  if ('error' in auth) return auth.error

  const q = getQuery<{ limit?: number }>(request, {
    limit: (v) => Math.min(100, Math.max(1, parseInt(v, 10) || 50)),
  })

  const admin = createSupabaseAdminClient()
  const { data, error } = await admin
    .from('tickets')
    .select('id, name, status, deleted_at, deleted_by, updated_at')
    .not('deleted_at', 'is', null)
    .order('deleted_at', { ascending: false })
    .limit(q.limit ?? 50)

  if (error) {
    return NextResponse.json(
      { code: 'db_error', error: 'db_error', message: error.message },
      { status: 500 },
    )
  }
  return NextResponse.json({ data: data ?? [] })
}
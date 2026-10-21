import { NextResponse } from 'next/server'
import { requirePermission } from '@/lib/auth'
import { getQuery } from '@/lib/validate'
import { listAuditEntries, type AuditAction, type AuditScope } from '@/services/audit'

/**
 * GET /api/audit — A1.
 *
 * Movements made by Supervisores and Soporte. Requires the `admin.viewAudit`
 * key, which by default only Admin holds — but an Admin may hand it to a
 * supervisor, and the route follows the key, not the role name.
 *
 * Read-only by design. There is no POST/PATCH/DELETE — the black box works
 * only if nobody can alter it.
 */
export async function GET(request: Request) {
  const auth = await requirePermission(['admin.viewAudit'], request)
  if ('error' in auth) return auth.error

  const q = getQuery<{
    action?: string
    actor_id?: string
    scope?: string
    page?: number
    limit?: number
  }>(request, {
    page: (v) => Math.max(1, parseInt(v, 10) || 1),
    limit: (v) => Math.min(200, Math.max(1, parseInt(v, 10) || 50)),
  })

  if (q.action && !isAuditAction(q.action)) {
    return NextResponse.json(
      {
        code: 'validation_failed',
        error: 'validation_failed',
        message: `Unknown action: ${q.action}`,
      },
      { status: 400 },
    )
  }
  if (q.scope && !isAuditScope(q.scope)) {
    return NextResponse.json(
      {
        code: 'validation_failed',
        error: 'validation_failed',
        message: `Unknown scope: ${q.scope}`,
      },
      { status: 400 },
    )
  }

  try {
    const data = await listAuditEntries({
      action: q.action as AuditAction | undefined,
      actor_id: q.actor_id,
      scope: q.scope as AuditScope | undefined,
      page: q.page ?? 1,
      limit: q.limit ?? 50,
    })
    return NextResponse.json({ data })
  } catch (err) {
    return NextResponse.json(
      { code: 'db_error', error: 'db_error', message: (err as Error).message },
      { status: 500 },
    )
  }
}

function isAuditAction(v: string): v is AuditAction {
  return [
    'created',
    'assigned',
    'reassigned',
    'category_changed',
    'theme_changed',
    'flow_changed',
    'status_changed',
    'closed',
    'reopened',
    'trashed',
    'restored',
  ].includes(v)
}

function isAuditScope(v: string): v is AuditScope {
  return ['ticket', 'conversation'].includes(v)
}
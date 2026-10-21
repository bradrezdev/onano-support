import { NextResponse } from 'next/server'
import { requirePermission } from '@/lib/auth'
import { getMyInbox } from '@/services/inbox'

/**
 * GET /api/dashboard — D1, "Mi bandeja".
 *
 * Resolved to a concrete design in this implementation cycle:
 *
 *   mine        — open tickets assigned to me
 *   overdue     — mine, past due. NULL due_at is never overdue.
 *   unassigned  — open tickets with no owner
 *   unread      — open conversations with pending inbound messages
 *
 * Not a wall of gauges. Every tile answers "what do I do next" and links
 * straight to the list behind it.
 *
 * The scope is the caller's: `mine` is filtered by their own id, so nobody
 * sees another agent's queue through this endpoint.
 */
export async function GET(request: Request) {
  const auth = await requirePermission(['conversation.read'], request)
  if ('error' in auth) return auth.error

  try {
    const data = await getMyInbox(auth.user.id)
    return NextResponse.json({ data })
  } catch (err) {
    return NextResponse.json(
      { code: 'db_error', error: 'db_error', message: (err as Error).message },
      { status: 500 },
    )
  }
}
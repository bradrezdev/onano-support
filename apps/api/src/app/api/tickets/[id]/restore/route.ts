import { NextResponse } from 'next/server'
import { requirePermission } from '@/lib/auth'
import { restoreTicket, TicketValidationError } from '@/services/tickets'

type Params = { params: Promise<{ id: string }> }

/**
 * POST /api/tickets/:id/restore — bring a trashed ticket back.
 *
 * Shares the `ticket.delete` key with trashing: whoever can hide a ticket can
 * also un-hide it. Splitting the key would let someone restore tickets they
 * are not allowed to remove in the first place.
 */
export async function POST(request: Request, ctx: Params) {
  const auth = await requirePermission(['ticket.delete'], request)
  if ('error' in auth) return auth.error
  const { id } = await ctx.params

  try {
    const ticket = await restoreTicket(id, auth.user.id)
    return NextResponse.json({ data: ticket })
  } catch (err) {
    if (err instanceof TicketValidationError) {
      return NextResponse.json(
        { code: err.code, error: err.code, message: err.message },
        { status: err.status },
      )
    }
    return NextResponse.json(
      { code: 'db_error', error: 'db_error', message: (err as Error).message },
      { status: 500 },
    )
  }
}
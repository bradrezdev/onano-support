import { NextResponse } from 'next/server'
import { requirePermission } from '@/lib/auth'
import { reopenTicket, TicketValidationError } from '@/services/tickets'

type Params = { params: Promise<{ id: string }> }

/**
 * POST /api/tickets/:id/reopen
 *
 * T4: whoever holds `ticket.reopen`. Admin and Supervisor by default — Soporte
 * closes but does not reopen, because reopening overrides someone else's
 * decision.
 */
export async function POST(request: Request, ctx: Params) {
  const auth = await requirePermission(['ticket.reopen'], request)
  if ('error' in auth) return auth.error
  const { id } = await ctx.params

  try {
    const ticket = await reopenTicket(id, auth.user.id)
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
import { NextResponse } from 'next/server'
import { requirePermission } from '@/lib/auth'
import { closeTicket, TicketValidationError } from '@/services/tickets'

type Params = { params: Promise<{ id: string }> }

/**
 * POST /api/tickets/:id/close
 *
 * T4: whoever holds `ticket.close`. By default that is Admin, Supervisor and
 * Soporte — and an Admin can grant it to a custom role without touching code.
 */
export async function POST(request: Request, ctx: Params) {
  const auth = await requirePermission(['ticket.close'], request)
  if ('error' in auth) return auth.error
  const { id } = await ctx.params

  try {
    const ticket = await closeTicket(id, auth.user.id)
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
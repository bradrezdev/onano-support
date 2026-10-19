import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireRole } from '@/lib/auth'
import { parseJson } from '@/lib/validate'
import { moveTicket, TicketValidationError } from '@/services/tickets'

const MoveBody = z.object({
  flow_id: z.string().uuid().nullable(),
})

type Params = { params: Promise<{ id: string }> }

export async function POST(request: Request, ctx: Params) {
  const auth = await requireRole(['admin', 'supervisor', 'soporte'], request)
  if ('error' in auth) return auth.error
  const { id } = await ctx.params

  const parsed = await parseJson(request, MoveBody)
  if ('error' in parsed) return parsed.error

  try {
    const ticket = await moveTicket(id, parsed.data.flow_id, auth.user.id)
    return NextResponse.json({ data: ticket })
  } catch (err) {
    if (err instanceof TicketValidationError) {
      return NextResponse.json(
        { code: err.code, error: err.code, message: err.message },
        { status: err.status },
      )
    }
    if ((err as { code?: string }).code === '23503') {
      return NextResponse.json(
        { code: 'invalid_flow', error: 'invalid_flow', message: 'flow_id does not exist' },
        { status: 400 },
      )
    }
    return NextResponse.json(
      { code: 'db_error', error: 'db_error', message: (err as Error).message },
      { status: 500 },
    )
  }
}
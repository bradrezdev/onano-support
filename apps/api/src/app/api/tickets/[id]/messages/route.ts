import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireRole } from '@/lib/auth'
import { parseJson } from '@/lib/validate'
import {
  createTicketMessage,
  listTicketMessages,
  TicketMessageError,
} from '@/services/ticket-messages'
import { findTicketOrThrow } from '@/services/tickets'

type Params = { params: Promise<{ id: string }> }

const CreateMessage = z.object({
  body: z.unknown(),
})

export async function GET(request: Request, ctx: Params) {
  const auth = await requireRole(['admin', 'supervisor', 'soporte'], request)
  if ('error' in auth) return auth.error
  const { id } = await ctx.params

  // Ensure ticket exists; 404 instead of empty list for clarity.
  try {
    await findTicketOrThrow(id)
  } catch {
    return NextResponse.json(
      { code: 'not_found', error: 'not_found', message: 'Ticket no encontrado' },
      { status: 404 },
    )
  }

  try {
    const messages = await listTicketMessages(id)
    return NextResponse.json({ data: messages })
  } catch (err) {
    return NextResponse.json(
      {
        code: 'db_error',
        error: 'db_error',
        message: (err as Error).message,
      },
      { status: 500 },
    )
  }
}

export async function POST(request: Request, ctx: Params) {
  const auth = await requireRole(['admin', 'supervisor', 'soporte'], request)
  if ('error' in auth) return auth.error
  const { id } = await ctx.params

  const parsed = await parseJson(request, CreateMessage)
  if ('error' in parsed) return parsed.error

  try {
    const message = await createTicketMessage(
      id,
      parsed.data.body,
      auth.user.id,
      auth.user.role,
    )
    return NextResponse.json({ data: message }, { status: 201 })
  } catch (err) {
    if (err instanceof TicketMessageError) {
      return NextResponse.json(
        { code: err.code, error: err.code, message: err.message },
        { status: err.status },
      )
    }
    return NextResponse.json(
      {
        code: 'db_error',
        error: 'db_error',
        message: (err as Error).message,
      },
      { status: 500 },
    )
  }
}
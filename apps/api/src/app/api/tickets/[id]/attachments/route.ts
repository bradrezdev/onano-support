import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requirePermission } from '@/lib/auth'
import { parseJson } from '@/lib/validate'
import {
  listTicketAttachments,
  attachMessages,
  AttachmentError,
} from '@/services/message-attachments'

type Params = { params: Promise<{ id: string }> }

const AttachBody = z.object({
  message_ids: z.array(z.string().uuid()).min(1).max(100),
  note: z.string().max(500).optional(),
})

/**
 * GET /api/tickets/:id/attachments — the messages pinned to this ticket (W1).
 *
 * `ticket.read` rather than a stronger key: seeing the evidence is part of
 * reading the ticket, not a separate power.
 *
 * The list is filtered ROW BY ROW: a ticket can hold evidence from several
 * chats and each row has its own holder. The ticket's holder sees all of it,
 * but an agent who only attends one of those chats sees only that chat's
 * evidence. The same rule applies to the preview and to the download.
 */
export async function GET(request: Request, ctx: Params) {
  const auth = await requirePermission(['ticket.read'], request)
  if ('error' in auth) return auth.error
  const { id } = await ctx.params

  try {
    return NextResponse.json({ data: await listTicketAttachments(id, auth.user) })
  } catch (err) {
    if (err instanceof AttachmentError) {
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

/**
 * POST /api/tickets/:id/attachments — pin selected messages to the ticket.
 *
 * `ticket.reply`, not a dedicated key: attaching evidence is part of working
 * the case. Idempotent on (ticket, message).
 */
export async function POST(request: Request, ctx: Params) {
  const auth = await requirePermission(['ticket.reply'], request)
  if ('error' in auth) return auth.error
  const { id } = await ctx.params

  const parsed = await parseJson(request, AttachBody)
  if ('error' in parsed) return parsed.error

  try {
    const result = await attachMessages(
      id,
      parsed.data.message_ids,
      auth.user.id,
      parsed.data.note,
      auth.user,
    )
    return NextResponse.json({ data: result }, { status: 201 })
  } catch (err) {
    if (err instanceof AttachmentError) {
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
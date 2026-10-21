import { NextResponse } from 'next/server'
import { requirePermission } from '@/lib/auth'
import { getQuery } from '@/lib/validate'
import { findConversationOrThrow, canAccessConversation, ConversationError } from '@/services/conversations'
import { listAttachableMessages } from '@/services/message-attachments'

type Params = { params: Promise<{ id: string }> }

/**
 * GET /api/conversations/:id/attachable?ticket_id=… — W1.
 *
 * Messages in this conversation that can still be pinned to the given ticket.
 * Already-attached ones are filtered out, so the picker only offers choices
 * that will actually do something.
 *
 * Requires `ticket.read` AND passes `canAccessConversation`: Soporte may not
 * pull evidence out of a conversation they do not own, even with the ticket
 * key. Two gates, because the ticket and the conversation are different
 * subjects.
 */
export async function GET(request: Request, ctx: Params) {
  const auth = await requirePermission(['ticket.read'], request)
  if ('error' in auth) return auth.error
  const { id } = await ctx.params

  const q = getQuery<{ ticket_id?: string; limit?: number }>(request, {
    limit: (v) => Math.min(100, Math.max(1, parseInt(v, 10) || 50)),
  })

  if (!q.ticket_id) {
    return NextResponse.json(
      {
        code: 'validation_failed',
        error: 'validation_failed',
        message: 'ticket_id is required',
      },
      { status: 400 },
    )
  }

  try {
    const conversation = await findConversationOrThrow(id)
    if (!canAccessConversation(auth.user, conversation)) {
      return NextResponse.json(
        {
          code: 'forbidden',
          error: 'forbidden',
          message: 'No tienes acceso a esta conversación',
        },
        { status: 403 },
      )
    }

    const data = await listAttachableMessages(id, q.ticket_id, q.limit ?? 50)
    return NextResponse.json({ data })
  } catch (err) {
    if (err instanceof ConversationError) {
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
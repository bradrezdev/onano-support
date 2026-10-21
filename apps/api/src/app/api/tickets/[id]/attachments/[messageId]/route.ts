import { NextResponse } from 'next/server'
import { requirePermission } from '@/lib/auth'
import { detachMessage, AttachmentError } from '@/services/message-attachments'

type Params = { params: Promise<{ id: string; messageId: string }> }

/**
 * DELETE /api/tickets/:id/attachments/:messageId — unpin a message.
 *
 * The row in `ticket_message_attachments` disappears; the message in
 * `messages` does not. Unpinning is a judgement ("this was the wrong
 * evidence"), never a way to delete a message.
 */
export async function DELETE(request: Request, ctx: Params) {
  const auth = await requirePermission(['ticket.reply'], request)
  if ('error' in auth) return auth.error
  const { id, messageId } = await ctx.params

  try {
    await detachMessage(id, messageId)
    return new NextResponse(null, { status: 204 })
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
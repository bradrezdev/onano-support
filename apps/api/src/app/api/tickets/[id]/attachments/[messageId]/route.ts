import { NextResponse } from 'next/server'
import { requirePermission } from '@/lib/auth'
import {
  detachMessage,
  getTicketAttachment,
  AttachmentError,
} from '@/services/message-attachments'

type Params = { params: Promise<{ id: string; messageId: string }> }

/**
 * GET /api/tickets/:id/attachments/:messageId — one attachment.
 *
 * The FILE is not served as bytes: the API authorizes the caller first and
 * then issues a signed URL that expires in five minutes. The bucket is
 * private and the Storage policies for `authenticated` are dropped, so this
 * is the only way to reach the object.
 */
export async function GET(request: Request, ctx: Params) {
  const auth = await requirePermission(['ticket.read'], request)
  if ('error' in auth) return auth.error
  const { id, messageId } = await ctx.params

  try {
    const attachment = await getTicketAttachment(id, messageId, auth.user)
    return NextResponse.json({ data: attachment })
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
 * DELETE /api/tickets/:id/attachments/:messageId — unpin a message.
 *
 * The row in `ticket_message_attachments` disappears; the message in
 * `messages` does not. Unpinning is a judgement ("this was the wrong
 * evidence"), never a way to delete a message.
 *
 * The FILE the attachment owned is deleted from Storage too: leaving it in
 * the bucket would keep it downloadable by anybody who knows the path.
 */
export async function DELETE(request: Request, ctx: Params) {
  const auth = await requirePermission(['ticket.reply'], request)
  if ('error' in auth) return auth.error
  const { id, messageId } = await ctx.params

  try {
    await detachMessage(id, messageId, auth.user)
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

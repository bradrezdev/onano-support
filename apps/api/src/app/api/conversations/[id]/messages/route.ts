import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requirePermission } from '@/lib/auth'
import { parseJson } from '@/lib/validate'
import { appendOutboundMessage, ConversationError } from '@/services/conversations'

type Params = { params: Promise<{ id: string }> }

const ReplyBody = z.object({
  body: z.string().min(1).max(4096),
})

/**
 * Agent posts an outbound reply. Inserts into messages with direction='out',
 * increments conversations.last_message_at via DB trigger.
 *
 * The actual Twilio HTTP send is deferred: this slice only persists the
 * message. A separate worker (not in scope here) will pick it up and POST
 * to Twilio once TWILIO_* env vars are configured.
 */
export async function POST(request: Request, ctx: Params) {
  const auth = await requirePermission(['conversation.assign'], request)
  if ('error' in auth) return auth.error
  const { id } = await ctx.params

  const parsed = await parseJson(request, ReplyBody)
  if ('error' in parsed) return parsed.error

  try {
    const message = await appendOutboundMessage({
      conversation_id: id,
      body: parsed.data.body,
      sent_by_id: auth.user.id,
    })
    return NextResponse.json({ data: message }, { status: 201 })
  } catch (err) {
    if (err instanceof ConversationError) {
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

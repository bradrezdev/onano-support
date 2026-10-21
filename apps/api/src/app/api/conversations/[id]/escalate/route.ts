import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requirePermission } from '@/lib/auth'
import { parseJson } from '@/lib/validate'
import { escalateConversation, ConversationError } from '@/services/conversations'

type Params = { params: Promise<{ id: string }> }

const EscalateBody = z.object({
  to_user_id: z.string().uuid(),
})

/**
 * POST /api/conversations/:id/escalate — W3, "pedir apoyo".
 *
 * Soporte asks somebody else to answer. Ownership does NOT transfer: the
 * escalation is a request, and the UI shows a banner until it is answered.
 */
export async function POST(request: Request, ctx: Params) {
  const auth = await requirePermission(['conversation.escalate'], request)
  if ('error' in auth) return auth.error
  const { id } = await ctx.params

  const parsed = await parseJson(request, EscalateBody)
  if ('error' in parsed) return parsed.error

  try {
    const result = await escalateConversation(id, parsed.data.to_user_id, auth.user.id)
    return NextResponse.json({ data: result })
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

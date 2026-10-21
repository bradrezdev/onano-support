import { NextResponse } from 'next/server'
import { requirePermission } from '@/lib/auth'
import { takeConversation, ConversationError } from '@/services/conversations'

type Params = { params: Promise<{ id: string }> }

/**
 * POST /api/conversations/:id/take — "Tomar" (recommendation 7).
 *
 * Any role can claim an unassigned conversation. Returns 409 when somebody
 * else claimed it first, so two agents pressing the button at the same moment
 * do not silently overwrite each other.
 */
export async function POST(request: Request, ctx: Params) {
  const auth = await requirePermission(['conversation.assign'], request)
  if ('error' in auth) return auth.error
  const { id } = await ctx.params

  try {
    const conversation = await takeConversation(id, auth.user.id)
    return NextResponse.json({ data: conversation })
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

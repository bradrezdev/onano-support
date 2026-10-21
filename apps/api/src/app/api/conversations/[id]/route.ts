import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requirePermission } from '@/lib/auth'
import { parseJson } from '@/lib/validate'
import {
  getConversationDetail,
  findConversationOrThrow,
  canAccessConversation,
  reassignConversation,
  ConversationError,
} from '@/services/conversations'

type Params = { params: Promise<{ id: string }> }

/**
 * GET /api/conversations/:id — thread detail.
 *
 * W2: Admin and Supervisor read any conversation. Soporte only the ones they
 * own plus the unassigned queue (so they can take one). The check is here in
 * the backend, not in the SPA.
 */
export async function GET(request: Request, ctx: Params) {
  const auth = await requirePermission(['conversation.read'], request)
  if ('error' in auth) return auth.error
  const { id } = await ctx.params

  try {
    const existing = await findConversationOrThrow(id)
    if (!canAccessConversation(auth.user, existing)) {
      return NextResponse.json(
        {
          code: 'forbidden',
          error: 'forbidden',
          message: 'No tienes acceso a esta conversación',
        },
        { status: 403 },
      )
    }

    const data = await getConversationDetail(id)
    if (!data) {
      return NextResponse.json(
        { code: 'not_found', error: 'not_found', message: 'Conversación no encontrada' },
        { status: 404 },
      )
    }
    return NextResponse.json({ data })
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

const ConversationPatchBody = z.object({
  assigned_agent_id: z.string().uuid().nullable(),
})

/**
 * PATCH /api/conversations/:id — W4, Admin/Supervisor reassign.
 * Setting `assigned_agent_id` to null returns the conversation to the queue.
 */
export async function PATCH(request: Request, ctx: Params) {
  const auth = await requirePermission(['conversation.reassign'], request)
  if ('error' in auth) return auth.error
  const { id } = await ctx.params

  const parsed = await parseJson(request, ConversationPatchBody)
  if ('error' in parsed) return parsed.error

  try {
    const conversation = await reassignConversation(
      id,
      parsed.data.assigned_agent_id,
      auth.user.id,
    )
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
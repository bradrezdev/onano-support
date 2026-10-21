import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requirePermission } from '@/lib/auth'
import { parseJson, getQuery } from '@/lib/validate'
import {
  listConversations,
  findOrCreateConversationForContact,
  ConversationError,
} from '@/services/conversations'

const ListQuery = z.object({
  contact_id: z.string().uuid().optional(),
  assigned_agent_id: z.string().uuid().optional(),
  status: z.enum(['open', 'pending', 'closed']).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  /** Soporte only: restrict to conversations they already took. */
  mine: z.coerce.boolean().optional(),
})

const CreateBody = z.object({
  contact_id: z.string().uuid(),
})

export async function GET(request: Request) {
  const auth = await requirePermission(['conversation.read'], request)
  if ('error' in auth) return auth.error

  const parsed = ListQuery.safeParse(getQuery(request, {
    limit: (v) => Number(v),
  }))
  if (!parsed.success) {
    return NextResponse.json(
      {
        code: 'validation_failed',
        error: 'validation_failed',
        message: 'Invalid query params',
        details: parsed.error.issues,
      },
      { status: 400 },
    )
  }

  const filter = parsed.data
  try {
    // W2: Soporte only sees the conversations they own, plus the unassigned
    // queue so they can claim one. `mine=true` narrows to their own only.
    const scope =
      auth.user.role === 'soporte'
        ? filter.mine
          ? { assigned_agent_id: auth.user.id }
          : { assigned_agent_id: auth.user.id, include_unassigned: true }
        : filter

    const data = await listConversations(scope)
    return NextResponse.json({ data })
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

/**
 * Admin creates a conversation for a contact (testing / seed flow).
 * Production conversations are created automatically by the inbound webhook.
 */
export async function POST(request: Request) {
  const auth = await requirePermission(['conversation.assign'], request)
  if ('error' in auth) return auth.error

  const parsed = await parseJson(request, CreateBody)
  if ('error' in parsed) return parsed.error

  try {
    const conversation = await findOrCreateConversationForContact(parsed.data.contact_id)
    return NextResponse.json({ data: conversation }, { status: 201 })
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

import { NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { listLinkedConversations } from '@/services/conversation-links'

type Params = { params: Promise<{ id: string }> }

/**
 * List conversations linked to this ticket. Multiple allowed.
 */
export async function GET(request: Request, ctx: Params) {
  const auth = await requireRole(['admin', 'supervisor', 'soporte'], request)
  if ('error' in auth) return auth.error
  const { id } = await ctx.params

  try {
    const data = await listLinkedConversations(id)
    return NextResponse.json({ data })
  } catch (err) {
    return NextResponse.json(
      { code: 'db_error', error: 'db_error', message: (err as Error).message },
      { status: 500 },
    )
  }
}
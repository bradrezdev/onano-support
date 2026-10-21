import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requirePermission } from '@/lib/auth'
import { parseJson } from '@/lib/validate'
import { listLinkedTickets, linkTicketToConversation, LinkError } from '@/services/conversation-links'

type Params = { params: Promise<{ id: string }> }

const LinkBody = z.object({
  ticket_id: z.string().uuid(),
})

export async function GET(request: Request, ctx: Params) {
  const auth = await requirePermission(['conversation.read'], request)
  if ('error' in auth) return auth.error
  const { id } = await ctx.params

  try {
    const data = await listLinkedTickets(id)
    return NextResponse.json({ data })
  } catch (err) {
    return NextResponse.json(
      { code: 'db_error', error: 'db_error', message: (err as Error).message },
      { status: 500 },
    )
  }
}

/**
 * Link an existing ticket to this conversation. Idempotent on the composite
 * PK (conversation_id, ticket_id). Multiple tickets per conversation allowed.
 */
export async function POST(request: Request, ctx: Params) {
  const auth = await requirePermission(['ticket.create'], request)
  if ('error' in auth) return auth.error
  const { id } = await ctx.params

  const parsed = await parseJson(request, LinkBody)
  if ('error' in parsed) return parsed.error

  try {
    const link = await linkTicketToConversation(id, parsed.data.ticket_id, auth.user.id)
    return NextResponse.json({ data: link }, { status: 201 })
  } catch (err) {
    if (err instanceof LinkError) {
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

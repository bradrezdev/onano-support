import { NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { unlinkTicketFromConversation, LinkError } from '@/services/conversation-links'

type Params = { params: Promise<{ id: string; ticketId: string }> }

export async function DELETE(request: Request, ctx: Params) {
  const auth = await requireRole(['admin', 'supervisor', 'soporte'], request)
  if ('error' in auth) return auth.error
  const { id, ticketId } = await ctx.params

  try {
    const result = await unlinkTicketFromConversation(id, ticketId)
    return NextResponse.json({ data: result })
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
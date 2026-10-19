import { NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { getConversationDetail } from '@/services/conversations'

type Params = { params: Promise<{ id: string }> }

export async function GET(request: Request, ctx: Params) {
  const auth = await requireRole(['admin', 'supervisor', 'soporte'], request)
  if ('error' in auth) return auth.error
  const { id } = await ctx.params

  try {
    const data = await getConversationDetail(id)
    if (!data) {
      return NextResponse.json(
        { code: 'not_found', error: 'not_found', message: 'Conversación no encontrada' },
        { status: 404 },
      )
    }
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
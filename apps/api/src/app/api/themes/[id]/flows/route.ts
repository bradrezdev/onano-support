import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireRole } from '@/lib/auth'
import { parseJson } from '@/lib/validate'
import { createFlow, ThemeError } from '@/services/themes'

const FlowCreate = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(500).nullable().optional(),
  is_terminal: z.boolean().optional(),
})

type Params = { params: Promise<{ id: string }> }

export async function POST(request: Request, ctx: Params) {
  const auth = await requireRole(['admin'], request)
  if ('error' in auth) return auth.error
  const { id: themeId } = await ctx.params

  const parsed = await parseJson(request, FlowCreate)
  if ('error' in parsed) return parsed.error

  try {
    const flow = await createFlow(themeId, parsed.data)
    return NextResponse.json({ data: flow }, { status: 201 })
  } catch (err) {
    if (err instanceof ThemeError) {
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
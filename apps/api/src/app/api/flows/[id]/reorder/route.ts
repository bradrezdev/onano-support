import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireRole } from '@/lib/auth'
import { parseJson } from '@/lib/validate'
import { reorderFlows, findFlowOrThrow, ThemeError } from '@/services/themes'

const ReorderBody = z.object({
  theme_id: z.string().uuid(),
  ordered_ids: z.array(z.string().uuid()).min(1),
})

type Params = { params: Promise<{ id: string }> }

export async function POST(request: Request, ctx: Params) {
  const auth = await requireRole(['admin', 'supervisor'], request)
  if ('error' in auth) return auth.error
  const { id: firstId } = await ctx.params

  const parsed = await parseJson(request, ReorderBody)
  if ('error' in parsed) return parsed.error

  if (!parsed.data.ordered_ids.includes(firstId)) {
    return NextResponse.json(
      { code: 'invalid_id', error: 'invalid_id', message: 'ordered_ids must include the URL flow id' },
      { status: 400 },
    )
  }

  try {
    // Sanity: ensure the first id belongs to the theme.
    const first = await findFlowOrThrow(firstId)
    if (first.theme_id !== parsed.data.theme_id) {
      return NextResponse.json(
        { code: 'theme_mismatch', error: 'theme_mismatch', message: 'flow does not belong to theme' },
        { status: 400 },
      )
    }
    const flows = await reorderFlows(parsed.data.theme_id, parsed.data.ordered_ids)
    return NextResponse.json({ data: flows })
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
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requirePermission } from '@/lib/auth'
import { parseJson } from '@/lib/validate'
import { updateFlow, deleteFlow, ThemeError } from '@/services/themes'

const FlowPatch = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(500).nullable().optional(),
  is_terminal: z.boolean().optional(),
  // Recommendation 5: shared phase vocabulary.
  group_key: z.enum(['pendiente', 'en_trabajo', 'en_espera', 'terminado']).nullable().optional(),
})

type Params = { params: Promise<{ id: string }> }

export async function PATCH(request: Request, ctx: Params) {
  const auth = await requirePermission(['flow.create'], request)
  if ('error' in auth) return auth.error
  const { id } = await ctx.params

  const parsed = await parseJson(request, FlowPatch)
  if ('error' in parsed) return parsed.error

  try {
    const flow = await updateFlow(id, parsed.data)
    return NextResponse.json({ data: flow })
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

export async function DELETE(request: Request, ctx: Params) {
  const auth = await requirePermission(['flow.delete'], request)
  if ('error' in auth) return auth.error
  const { id } = await ctx.params

  try {
    await deleteFlow(id)
    return new NextResponse(null, { status: 204 })
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

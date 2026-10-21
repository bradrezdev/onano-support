import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requirePermission } from '@/lib/auth'
import { parseJson } from '@/lib/validate'
import { updateTheme, deleteTheme, ThemeError } from '@/services/themes'

const ThemePatch = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(500).nullable().optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
})

type Params = { params: Promise<{ id: string }> }

export async function PATCH(request: Request, ctx: Params) {
  const auth = await requirePermission(['theme.create'], request)
  if ('error' in auth) return auth.error
  const { id } = await ctx.params

  const parsed = await parseJson(request, ThemePatch)
  if ('error' in parsed) return parsed.error

  try {
    const theme = await updateTheme(id, parsed.data)
    return NextResponse.json({ data: theme })
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
  const auth = await requirePermission(['theme.delete'], request)
  if ('error' in auth) return auth.error
  const { id } = await ctx.params

  try {
    await deleteTheme(id)
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

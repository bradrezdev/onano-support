import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requirePermission } from '@/lib/auth'
import { parseJson } from '@/lib/validate'
import { listThemesWithFlows, createTheme, ThemeError } from '@/services/themes'

const ThemeCreate = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(500).nullable().optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
})

export async function GET(request: Request) {
  const auth = await requirePermission(['conversation.read'], request)
  if ('error' in auth) return auth.error

  const themes = await listThemesWithFlows()
  return NextResponse.json({ data: themes })
}

export async function POST(request: Request) {
  const auth = await requirePermission(['theme.create'], request)
  if ('error' in auth) return auth.error

  const parsed = await parseJson(request, ThemeCreate)
  if ('error' in parsed) return parsed.error

  try {
    const theme = await createTheme(parsed.data, auth.user.id)
    return NextResponse.json({ data: theme }, { status: 201 })
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

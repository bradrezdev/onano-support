import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireRole } from '@/lib/auth'
import { parseJson } from '@/lib/validate'
import {
  findUserOrThrow,
  getUserTicketCounts,
  updateUser,
  UserValidationError,
} from '@/services/users'

type Params = { params: Promise<{ id: string }> }

const UserPatchBody = z.object({
  role: z.enum(['admin', 'supervisor', 'soporte']).optional(),
  suspend: z.boolean().optional(),
  display_name: z.string().min(0).max(120).optional(),
})

export async function GET(request: Request, ctx: Params) {
  const auth = await requireRole(['admin', 'supervisor'], request)
  if ('error' in auth) return auth.error
  const { id } = await ctx.params

  try {
    const [user, counts] = await Promise.all([
      findUserOrThrow(id),
      getUserTicketCounts(id),
    ])
    return NextResponse.json({ data: { ...user, ...counts } })
  } catch (err) {
    const e = err as { code?: string; message?: string }
    if (e.code === 'user_not_found' || e.message?.includes('not found')) {
      return NextResponse.json(
        { code: 'not_found', error: 'not_found', message: 'User not found' },
        { status: 404 },
      )
    }
    return NextResponse.json(
      { code: 'db_error', error: 'db_error', message: e.message ?? 'Unknown' },
      { status: 500 },
    )
  }
}

export async function PATCH(request: Request, ctx: Params) {
  const auth = await requireRole(['admin'], request)
  if ('error' in auth) return auth.error
  const { id } = await ctx.params

  const parsed = await parseJson(request, UserPatchBody)
  if ('error' in parsed) return parsed.error

  try {
    const updated = await updateUser(id, parsed.data, auth.user.id)
    return NextResponse.json({ data: updated })
  } catch (err) {
    if (err instanceof UserValidationError) {
      const status =
        err.code === 'not_found' ? 404 : err.code === 'self_suspend' || err.code === 'self_demote' ? 409 : 400
      return NextResponse.json(
        { code: err.code, error: err.code, message: err.message },
        { status },
      )
    }
    return NextResponse.json(
      { code: 'db_error', error: 'db_error', message: (err as Error).message },
      { status: 500 },
    )
  }
}
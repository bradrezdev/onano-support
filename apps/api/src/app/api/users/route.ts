import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requirePermission } from '@/lib/auth'
import { getQuery, parseJson } from '@/lib/validate'
import { listUsers, searchUsers, createUser, UserValidationError } from '@/services/users'

/**
 * GET /api/users — full account list.
 *
 * R1: requires `admin.viewAccounts`. The key is separate from `admin.assignRole`
 * on purpose — reviewing who exists and changing what someone may do are two
 * different powers, and an Admin may want to delegate one without the other.
 */
export async function GET(request: Request) {
  const auth = await requirePermission(['admin.viewAccounts'], request)
  if ('error' in auth) return auth.error

  const q = getQuery<{ q?: string }>(request, {
    q: (v) => v,
  })

  if (q.q && q.q.trim()) {
    const users = await searchUsers(q.q)
    return NextResponse.json({ data: users })
  }
  const users = await listUsers()
  return NextResponse.json({ data: users })
}

const CreateUserBody = z.object({
  email: z.string().email(),
  // Long enough to be worth having. Supabase would accept 6; the floor here is
  // about not handing a colleague a password nobody would choose on purpose.
  password: z.string().min(8).max(200),
  display_name: z.string().max(120).optional(),
  role_key: z.string().min(1).max(60).optional(),
})

/**
 * POST /api/users — create an account.
 *
 * Requires `admin.createUser`, which was already a key in the catalogue with no
 * route behind it: the permission existed, the button could never be built.
 */
export async function POST(request: Request) {
  const auth = await requirePermission(['admin.createUser'], request)
  if ('error' in auth) return auth.error

  const parsed = await parseJson(request, CreateUserBody)
  if ('error' in parsed) return parsed.error

  try {
    const user = await createUser(parsed.data, auth.user.id)
    return NextResponse.json({ data: user }, { status: 201 })
  } catch (err) {
    if (err instanceof UserValidationError) {
      // An email that already exists is a conflict, not a bad request: the
      // caller can correct it by choosing a different address.
      const status = err.code === 'email_taken' ? 409 : err.status
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
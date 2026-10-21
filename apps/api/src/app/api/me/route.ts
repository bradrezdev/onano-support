import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireUser } from '@/lib/auth'
import { PERMISSION_CATALOG } from '@/lib/permissions'
import { parseJson } from '@/lib/validate'
import { updateOwnProfile } from '@/services/users'

/**
 * GET /api/me — the signed-in user's profile plus their resolved keyring.
 *
 * The SPA used to read `profiles` directly with the anon Supabase client,
 * which cannot answer "what may this person do" — permissions live in
 * role_permissions. This endpoint is the single source the UI asks.
 *
 * The response also carries the permission catalogue, so the client can build
 * the role editor without a second round trip.
 */
export async function GET(request: Request) {
  const auth = await requireUser(request)
  if ('error' in auth) return auth.error

  return NextResponse.json({
    data: {
      id: auth.user.id,
      email: auth.user.email,
      display_name: auth.user.display_name,
      phone: auth.user.phone,
      // Legacy column, still constrained to the three shipped slugs.
      role: auth.user.role,
      // Source of truth: the slug of the role in public.roles.
      role_key: auth.user.role_key,
      permissions: auth.user.permissions,
      suspended_at: auth.user.suspended_at,
      deleted_at: auth.user.deleted_at,
    },
    catalog: PERMISSION_CATALOG,
  })
}

/**
 * Two fields only: display name and phone. Role, suspension and the rest stay
 * admin-only — a user editing their own profile must not be able to reach them
 * by picking a different key, so the body schema is the whole allowlist.
 *
 * `strictObject`, not `object`. Zod's default is to *strip* unknown keys, which
 * is safe but dishonest: a client that sends `role` gets a 200 with nothing
 * written, and reads that as "saved". The live HTTP smoke test sent
 * `{role, suspended_at}` and got 200 back. Nothing escalated — the fields were
 * dropped — but the caller was told a lie. Rejecting is the honest answer, and
 * on an endpoint whose entire job is a two-field allowlist there is no reason
 * to be lenient about what else arrives.
 */
const OwnProfileBody = z.strictObject({
  display_name: z.string().max(120).optional(),
  phone: z.string().max(40).nullable().optional(),
})

/** PATCH /api/me — edit your own display name and phone number. */
export async function PATCH(request: Request) {
  const auth = await requireUser(request)
  if ('error' in auth) return auth.error

  const parsed = await parseJson(request, OwnProfileBody)
  if ('error' in parsed) return parsed.error

  // `requireUser` is the right gate here, not a permission: there is no key to
  // hold, because every account owns exactly one row and that row is itself.
  try {
    const data = await updateOwnProfile(auth.user.id, parsed.data)
    return NextResponse.json({
      data: {
        id: auth.user.id,
        email: auth.user.email,
        display_name: data.display_name,
        phone: data.phone,
      },
    })
  } catch (err) {
    return NextResponse.json(
      { code: 'db_error', error: 'db_error', message: (err as Error).message },
      { status: 500 },
    )
  }
}
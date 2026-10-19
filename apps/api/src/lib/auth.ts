import { cookies } from 'next/headers'
import { NextResponse } from 'next/server'
import { createSupabaseServerClient } from './supabase/server'
import { createSupabaseAdminClient } from './supabase/admin'

export interface AuthedUser {
  id: string
  email: string | null
  role: 'admin' | 'supervisor' | 'soporte'
  display_name: string | null
  suspended_at: string | null
  deleted_at: string | null
}

/**
 * Extract a Bearer access token from the Authorization header.
 * Returns null when the header is missing or malformed.
 */
function extractBearer(request: Request): string | null {
  const header = request.headers.get('authorization')
  if (!header) return null
  const [scheme, token] = header.split(' ')
  if (scheme?.toLowerCase() !== 'bearer' || !token) return null
  return token
}

/**
 * Returns the current authenticated user. Tries (in order):
 *   1. `Authorization: Bearer <jwt>` header (frontend API client)
 *   2. Supabase session cookie (server-rendered pages)
 * Then loads the profile row and rejects suspended/deleted users.
 */
export async function getCurrentUser(request?: Request): Promise<AuthedUser | null> {
  const bearer = request ? extractBearer(request) : null
  const admin = createSupabaseAdminClient()

  let userId: string | null = null
  let userEmail: string | null = null

  if (bearer) {
    const { data, error } = await admin.auth.getUser(bearer)
    if (!error && data.user) {
      userId = data.user.id
      userEmail = data.user.email ?? null
    }
  }

  if (!userId) {
    const supabase = await createSupabaseServerClient()
    const { data: sessionData } = await supabase.auth.getSession()
    if (sessionData.session?.user) {
      userId = sessionData.session.user.id
      userEmail = sessionData.session.user.email ?? null
    }
  }

  if (!userId) return null

  const { data: profileRow } = await admin
    .from('profiles')
    .select('id, role, display_name, suspended_at, deleted_at')
    .eq('id', userId)
    .maybeSingle<{
      id: string
      role: AuthedUser['role']
      display_name: string | null
      suspended_at: string | null
      deleted_at: string | null
    }>()

  const profile = profileRow
  if (!profile) return null
  if (profile.suspended_at || profile.deleted_at) return null

  return {
    id: userId,
    email: userEmail,
    role: profile.role,
    display_name: profile.display_name ?? null,
    suspended_at: profile.suspended_at ?? null,
    deleted_at: profile.deleted_at ?? null,
  }
}

/**
 * Returns 401 response when no user, 403 when role doesn't match.
 * Returns the user on success so callers can use it directly.
 */
export async function requireUser(request?: Request): Promise<
  { user: AuthedUser } | { error: NextResponse }
> {
  const user = await getCurrentUser(request)
  if (!user) {
    return {
      error: NextResponse.json(
        { code: 'unauthorized', error: 'unauthorized', message: 'Not signed in' },
        { status: 401 },
      ),
    }
  }
  return { user }
}

export async function requireRole(
  roles: AuthedUser['role'][],
  request?: Request,
): Promise<{ user: AuthedUser } | { error: NextResponse }> {
  const result = await requireUser(request)
  if ('error' in result) return result
  if (!roles.includes(result.user.role)) {
    return {
      error: NextResponse.json(
        {
          code: 'forbidden',
          error: 'forbidden',
          message: `Requires role: ${roles.join(' | ')}`,
        },
        { status: 403 },
      ),
    }
  }
  return result
}
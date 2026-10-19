import { createServerClient, type CookieOptions } from '@supabase/ssr'
import { cookies } from 'next/headers'

/**
 * Server-side Supabase client for use inside Next.js Route Handlers and
 * Server Components. Reads/writes the project's session cookies.
 *
 * The `setAll` branch is required by @supabase/ssr even though Next.js
 * Server Components cannot mutate cookies — the server client is allowed to
 * mutate the cookie store on writes, so we forward each cookie through.
 */
export async function createSupabaseServerClient() {
  const cookieStore = await cookies()

  const cookieOptions: CookieOptions = {
    path: '/',
    sameSite: 'lax',
    httpOnly: false,
    secure: process.env.NODE_ENV === 'production',
  }

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) => {
              cookieStore.set(name, value, { ...cookieOptions, ...options })
            })
          } catch {
            // Called from a Server Component — cookie writes are not permitted
            // here. The middleware refreshes the session on the next request.
          }
        },
      },
    },
  )
}
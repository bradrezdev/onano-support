import { createClient } from '@supabase/supabase-js'

/**
 * Service-role Supabase client for backend-only operations that must bypass
 * Row Level Security (admin actions, webhooks, scheduled jobs).
 *
 * Use with care — never expose this client or its queries to the browser.
 */
let cached: ReturnType<typeof createClient> | null = null

export function createSupabaseAdminClient() {
  if (cached) return cached

  const url = process.env.SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SECRET_KEY

  if (!url || !serviceRoleKey) {
    throw new Error(
      'Supabase admin client requires SUPABASE_URL and SUPABASE_SECRET_KEY in apps/api/.env.local',
    )
  }

  cached = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  return cached
}
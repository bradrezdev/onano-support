/**
 * Browser-side Supabase client. Uses the project's anon publishable key.
 * Auth tokens are stored in localStorage so they survive a refresh; the
 * Vite server reads them via getSession() for Authorization headers.
 */

import { createClient, type Session } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

if (!url || !key) {
  // eslint-disable-next-line no-console
  console.warn(
    '[supabase] VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY is missing; auth disabled.',
  )
}

export const supabase = createClient(url ?? 'http://localhost', key ?? 'anon', {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    storageKey: 'crm-web-auth',
  },
})

export async function getSession(): Promise<Session | null> {
  const { data } = await supabase.auth.getSession()
  return data.session
}
import { NextResponse } from 'next/server'
import { createSupabaseServerClient } from '@/lib/supabase/server'

/**
 * GET /api/health — smoke check.
 * Returns `{ ok: true }` when the server can reach Supabase (or at least
 * parse the env). Used by `pnpm dev` scripts to confirm the backend boots.
 *
 * Next.js 16 with Cache Components treats routes that touch runtime APIs
 * (cookies/headers) as dynamic by default, so no `dynamic` config is needed.
 */
export async function GET() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY

  if (!url || !key) {
    return NextResponse.json(
      {
        ok: false,
        error: 'missing_env',
        detail: 'NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY not set',
      },
      { status: 500 },
    )
  }

  // Touch the server client so missing/garbled env surfaces here instead of
  // crashing the first authenticated request.
  try {
    await createSupabaseServerClient()
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: 'supabase_init_failed', detail: (err as Error).message },
      { status: 500 },
    )
  }

  return NextResponse.json({
    ok: true,
    service: 'whatsapp-crm-api',
    runtime: 'nextjs',
    supabase_url: url,
    time: new Date().toISOString(),
  })
}
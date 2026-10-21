/**
 * HTTP smoke test: exercises the real route handlers over a real JWT, which
 * the unit tests cannot do (they call the handler with a mocked auth module).
 *
 * Signs in as the existing admin by minting a magic link with the service role
 * and exchanging it for a session — no password needed, and it exercises the
 * same auth path the SPA uses.
 *
 *   cd apps/api && pnpm tsx scripts/smoke-http.ts
 */
import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const URL = process.env.SUPABASE_URL!
const SERVICE = process.env.SUPABASE_SECRET_KEY!
// This project names the client-side key with the newer Supabase vocabulary
// (`publishable`) rather than the older `anon`. Accept either so the script
// does not rot if the key is renamed back.
const ANON =
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
  process.env.SUPABASE_ANON_KEY ??
  process.env.SUPABASE_PUBLIC_KEY!
const BASE = 'http://localhost:3000'
const ADMIN_EMAIL = 'b.nunez@hotmail.es'

let failures = 0
function check(label: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

async function main() {
  const service = createClient(URL, SERVICE, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  // --- mint a session for the admin --------------------------------------
  const { data: link, error: linkErr } = await service.auth.admin.generateLink({
    type: 'magiclink',
    email: ADMIN_EMAIL,
  })
  if (linkErr) throw new Error(`generateLink: ${linkErr.message}`)
  const tokenHash = link.properties?.hashed_token
  if (!tokenHash) throw new Error('no hashed_token in generateLink result')

  const anon = createClient(URL, ANON, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { data: sess, error: sessErr } = await anon.auth.verifyOtp({
    token_hash: tokenHash,
    type: 'magiclink',
  })
  if (sessErr) throw new Error(`verifyOtp: ${sessErr.message}`)
  const jwt = sess.session?.access_token
  if (!jwt) throw new Error('no access token')
  check('minted a real admin session', true, ADMIN_EMAIL)

  const call = async (path: string, init: RequestInit = {}) => {
    const res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${jwt}`,
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
    })
    const text = await res.text()
    let body: unknown = null
    try {
      body = text ? JSON.parse(text) : null
    } catch {
      body = text
    }
    return { status: res.status, body: body as Record<string, never> }
  }

  // --- GET /api/me carries phone -----------------------------------------
  const me = await call('/api/me')
  check('GET /api/me -> 200', me.status === 200, String(me.status))
  const meData = me.body?.data as Record<string, unknown> | undefined
  check('me exposes phone', 'phone' in (meData ?? {}), JSON.stringify(meData?.phone))

  // --- PATCH /api/me ------------------------------------------------------
  const before = meData?.display_name
  const patch = await call('/api/me', {
    method: 'PATCH',
    body: JSON.stringify({ phone: '+52 555 123 4567' }),
  })
  check('PATCH /api/me -> 200', patch.status === 200, JSON.stringify(patch.body))
  const afterMe = await call('/api/me')
  const afterData = afterMe.body?.data as Record<string, unknown> | undefined
  check('phone persisted', afterData?.phone === '+52 555 123 4567', String(afterData?.phone))

  // role is not in the allowlist — it must be rejected, not silently ignored
  const escalate = await call('/api/me', {
    method: 'PATCH',
    body: JSON.stringify({ role: 'admin', suspended_at: null }),
  })
  check(
    'PATCH /api/me refuses fields outside the allowlist',
    escalate.status === 400,
    `${escalate.status} ${JSON.stringify(escalate.body)}`,
  )

  // restore
  await call('/api/me', {
    method: 'PATCH',
    body: JSON.stringify({ display_name: before ?? '', phone: null }),
  })

  // --- GET /api/tickets/:id/context --------------------------------------
  const { data: anyTicket } = await service
    .from('tickets')
    .select('id')
    .is('deleted_at', null)
    .limit(1)
    .maybeSingle()
  if (!anyTicket) {
    console.log('SKIP  no live ticket to resolve')
  } else {
    const ctx = await call(`/api/tickets/${(anyTicket as { id: string }).id}/context`)
    check('GET context -> 200', ctx.status === 200, JSON.stringify(ctx.body).slice(0, 200))
    const d = ctx.body?.data as Record<string, { name?: string; display_name?: string } | null>
    check('client name resolved (not a uuid)', !!d?.client?.name, String(d?.client?.name))
    check('category name resolved', !!d?.category?.name, String(d?.category?.name))
    check('creator resolved', !!d?.creator, JSON.stringify(d?.creator))
  }

  // --- POST /api/users ----------------------------------------------------
  const email = `smoke.http.${Date.now()}@example.test`
  const created = await call('/api/users', {
    method: 'POST',
    body: JSON.stringify({
      email,
      password: 'http-pass-1234',
      display_name: 'HTTP Smoke',
      role_key: 'soporte',
    }),
  })
  check('POST /api/users -> 201', created.status === 201, JSON.stringify(created.body).slice(0, 200))
  const newId = (created.body?.data as { id?: string } | undefined)?.id

  // short password rejected before anything is created
  const weak = await call('/api/users', {
    method: 'POST',
    body: JSON.stringify({ email: `weak.${Date.now()}@example.test`, password: 'short' }),
  })
  check('POST /api/users rejects a 5-char password', weak.status === 400, String(weak.status))

  // the new account can actually take work
  if (newId) {
    const assignable = await call('/api/users/assignable')
    const list = (assignable.body?.data as { id: string }[]) ?? []
    check('new account appears in /api/users/assignable', list.some((u) => u.id === newId))
    await service.from('profiles').delete().eq('id', newId)
    await service.auth.admin.deleteUser(newId)
  }

  // --- PUT /api/role-colors ----------------------------------------------
  const { data: rcs } = await service
    .from('role_color_settings')
    .select('base_color, fade_steps')
    .eq('role', 'soporte')
    .maybeSingle<{ base_color: string; fade_steps: number }>()
  const put = await call('/api/role-colors', {
    method: 'PUT',
    body: JSON.stringify({
      role: 'soporte',
      base_color: rcs?.base_color ?? '#16a34a',
      fade_steps: rcs?.fade_steps ?? 5,
    }),
  })
  check('PUT /api/role-colors -> 200', put.status === 200, String(put.status))
  const { data: mirrored } = await service
    .from('roles')
    .select('color')
    .eq('key', 'soporte')
    .maybeSingle<{ color: string }>()
  check(
    'roles.color matches role_color_settings after PUT',
    mirrored?.color === (rcs?.base_color ?? '#16a34a'),
    `${String(mirrored?.color)}`,
  )

  // --- PATCH /api/categories/:id (rename) ---------------------------------
  const { data: cat } = await service
    .from('categories')
    .select('id, name')
    .limit(1)
    .maybeSingle<{ id: string; name: string }>()
  if (cat) {
    const renamed = `Smoke ${Date.now()}`
    const p = await call(`/api/categories/${cat.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ name: renamed }),
    })
    check('PATCH category -> 200', p.status === 200, String(p.status))
    const { data: back } = await service
      .from('categories')
      .select('name')
      .eq('id', cat.id)
      .maybeSingle<{ name: string }>()
    check('category renamed', back?.name === renamed, String(back?.name))
    await call(`/api/categories/${cat.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ name: cat.name }),
    })
  }

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
  process.exitCode = failures === 0 ? 0 : 1
}

main().catch((e) => {
  console.error('http smoke crashed:', e)
  process.exitCode = 1
})
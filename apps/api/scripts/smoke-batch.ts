/**
 * Live smoke test for the features added in this batch, run against the real
 * database. Not part of the suite: it creates and destroys a real auth account
 * so it must never run in CI or against a shared database.
 *
 *   cd apps/api && pnpm tsx scripts/smoke-batch.ts
 */
import 'dotenv/config'
import { createSupabaseAdminClient } from '../src/lib/supabase/admin'
import { createUser, updateOwnProfile } from '../src/services/users'
import { upsertRoleColor } from '../src/services/ticket-messages'

const admin = createSupabaseAdminClient()
let failures = 0

function check(label: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

async function main() {
  const stamp = Date.now()
  const email = `smoke.${stamp}@example.test`

  // created_by is a real FK to profiles(id), so the actor has to be a real
  // profile — 'system' would be rejected by Postgres, which is correct.
  const { data: actors } = await admin
    .from('profiles')
    .select('id')
    .limit(1)
  const actorId: string | undefined = actors?.[0]?.id as string | undefined
  if (!actorId) throw new Error('no profile to act as; cannot run smoke')

  // --- createUser: happy path -------------------------------------------
  const { data: before } = await admin.auth.admin.listUsers({ perPage: 1000 })
  const created = await createUser(
    { email, password: 'smoke-pass-1234', display_name: 'Smoke Test', role_key: 'auditor' },
    actorId,
  )
  check('createUser returns an id', !!created.id, created.id)
  check('createUser keeps the custom role key', created.role_key === 'auditor', created.role_key)

  const { data: prof } = await admin
    .from('profiles')
    .select('id, role_key, display_name')
    .eq('id', created.id)
    .maybeSingle()
  check('profiles row exists', !!prof, JSON.stringify(prof))
  check(
    'profiles.role_key is the custom role',
    prof?.role_key === 'auditor',
    String(prof?.role_key),
  )
  // The legacy column has a check constraint for the three shipped slugs, so
  // a custom role must not have tried to write it.
  const { data: legacy } = await admin
    .from('profiles')
    .select('role')
    .eq('id', created.id)
    .maybeSingle<{ role: string }>()
  check(
    'legacy role column kept its default for a custom role',
    legacy?.role === 'soporte',
    String(legacy?.role),
  )

  // --- duplicate email -> 409 path ---------------------------------------
  let dupCode = ''
  try {
    await createUser({ email, password: 'another-pass-1234' }, actorId)
  } catch (e) {
    dupCode = (e as { code?: string }).code ?? ''
  }
  check('duplicate email reports email_taken', dupCode === 'email_taken', dupCode)

  // --- updateOwnProfile --------------------------------------------------
  const patched = await updateOwnProfile(created.id, {
    display_name: '  Smoke Renamed  ',
    phone: 'llame al +52 555 0001111',
  })
  check('display_name is trimmed', patched.display_name === 'Smoke Renamed', String(patched.display_name))
  // Letters go, formatting survives: spaces, +, parens and hyphens are all legal
// in a written phone number, so they are kept rather than normalized away.
check(
  'phone strips letters but keeps formatting',
  patched.phone === '+52 555 0001111',
  String(patched.phone),
)

  // --- role color sync across both tables --------------------------------
  // Captured up front so the run can put it back. A smoke test that leaves
  // the workspace tinted a different color is a smoke test nobody runs twice.
  const { data: colorBefore } = await admin
    .from('role_color_settings')
    .select('base_color, fade_steps')
    .eq('role', 'soporte')
    .maybeSingle<{ base_color: string; fade_steps: number }>()
  const NEW = '#123456'
  await upsertRoleColor('soporte', NEW, 7, actorId)
  const { data: rcs } = await admin
    .from('role_color_settings')
    .select('base_color, fade_steps')
    .eq('role', 'soporte')
    .maybeSingle()
  const { data: rl } = await admin.from('roles').select('color').eq('key', 'soporte').maybeSingle()
  check('role_color_settings took the new color', rcs?.base_color === NEW, String(rcs?.base_color))
  check('fade_steps took 7', rcs?.fade_steps === 7, String(rcs?.fade_steps))
  check(
    'roles.color mirrored to the same value',
    rl?.color === NEW,
    `${String(rl?.color)} vs ${NEW}`,
  )

  await upsertRoleColor('soporte', colorBefore?.base_color ?? '#16a34a', colorBefore?.fade_steps ?? 5, actorId)
  const { data: colorRestored } = await admin
    .from('role_color_settings')
    .select('base_color')
    .eq('role', 'soporte')
    .maybeSingle<{ base_color: string }>()
  check('original color restored', colorRestored?.base_color === colorBefore?.base_color,
    `${String(colorRestored?.base_color)} (was ${String(colorBefore?.base_color)})`)

  // --- cleanup: exactly the compensating path a half-create would take -----
  await admin.from('profiles').delete().eq('id', created.id)
  await admin.auth.admin.deleteUser(created.id)
  const { data: after } = await admin.auth.admin.listUsers({ perPage: 1000 })
  const beforeUsers = before?.users ?? []
  const afterUsers = after?.users ?? []
  check(
    'cleanup removed the account',
    !afterUsers.some((u) => u.email === email),
    `list went ${beforeUsers.length} -> ${afterUsers.length}`,
  )

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
  process.exitCode = failures === 0 ? 0 : 1
}

main().catch((e) => {
  console.error('smoke crashed:', e)
  process.exitCode = 1
})
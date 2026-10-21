/**
 * Creates a temporary admin account for UI verification and prints the id so
 * the caller can delete it. Never run against a shared database.
 *
 *   cd apps/api && pnpm tsx scripts/make-e2e-admin.ts
 */
import 'dotenv/config'
import { createSupabaseAdminClient } from '../src/lib/supabase/admin'
import { createUser } from '../src/services/users'

const PASSWORD = 'e2e-verify-9931'
const EMAIL = `e2e.verify.${Date.now()}@example.test`

async function main() {
  const admin = createSupabaseAdminClient()
  const { data: actors } = await admin.from('profiles').select('id').limit(1)
  const actorId = actors?.[0]?.id as string
  if (!actorId) throw new Error('no profile to act as')

  const created = await createUser(
    { email: EMAIL, password: PASSWORD, display_name: 'E2E Verify', role_key: 'admin' },
    actorId,
  )
  console.log(JSON.stringify({ id: created.id, email: EMAIL, password: PASSWORD }))
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
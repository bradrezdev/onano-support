// @ts-nocheck
// One-off token minter for end-to-end smoke tests. Mints an access token via
// the Supabase auth admin API, then prints it on stdout. Used only from
// `db:exec` style ad-hoc verifications; never wired into the production app.

import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const url = process.env.SUPABASE_URL
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
const profileId = process.argv[2]

if (!url || !serviceKey || !profileId) {
  console.error('Usage: tsx mint-token.ts <profile_id>')
  process.exit(2)
}

const admin = createClient(url, serviceKey, { auth: { persistSession: false } })

const { data, error } = await admin.auth.admin.generateLink({
  type: 'magiclink',
  email: '',
} as never)

console.log(error || data)
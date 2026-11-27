#!/usr/bin/env node
/**
 * Traduce la salida de `supabase status -o env` a las variables que espera la
 * aplicación, y las publica en $GITHUB_ENV para los pasos siguientes.
 *
 * NO imprime ningún valor: los secretos de la instancia efímera no salen a la
 * consola ni al log del job. Si una variable falta, falla el paso: seguir con
 * una configuración a medias es exactamente el modo de fallo que este job
 * existe para evitar.
 *
 *   node scripts/ci/supabase-env.mjs <archivo-de-env>
 */

import { readFileSync, appendFileSync } from 'node:fs'

const file = process.argv[2]
if (!file) {
  console.error('uso: node scripts/ci/supabase-env.mjs <archivo-de-env>')
  process.exit(2)
}

const raw = readFileSync(file, 'utf8')
const parsed = {}
for (const line of raw.split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)="?(.*?)"?$/)
  if (m) parsed[m[1]] = m[2]
}

// La CLI reciente publica claves nuevas (sb_secret_/sb_publishable_); las
// antiguas (SERVICE_ROLE_KEY/ANON_KEY) son JWT que PostgREST y GoTrue
// entienden sin intermediarios. Se prefieren las viejas cuando existen y se
// cae a las nuevas si la CLI ya no las publica.
const apiUrl = parsed.API_URL ?? parsed.SUPABASE_URL
const secretKey = parsed.SERVICE_ROLE_KEY ?? parsed.SECRET_KEY
const publishableKey = parsed.ANON_KEY ?? parsed.PUBLISHABLE_KEY
const dbUrl = parsed.DB_URL ?? parsed.DATABASE_URL

const missing = []
if (!apiUrl) missing.push('API_URL')
if (!secretKey) missing.push('SECRET_KEY/SERVICE_ROLE_KEY')
if (!publishableKey) missing.push('PUBLISHABLE_KEY/ANON_KEY')
if (!dbUrl) missing.push('DB_URL')
if (missing.length > 0) {
  console.error(`FALTA: la instancia efímera no publicó ${missing.join(', ')}`)
  console.error('Claves encontradas: ' + Object.keys(parsed).join(', '))
  process.exit(1)
}

const out = {
  SUPABASE_URL: apiUrl,
  SUPABASE_SECRET_KEY: secretKey,
  NEXT_PUBLIC_SUPABASE_URL: apiUrl,
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: publishableKey,
  DATABASE_URL: dbUrl,
  VITE_SUPABASE_URL: apiUrl,
  VITE_SUPABASE_ANON_KEY: publishableKey,
}

if (process.env.GITHUB_ENV) {
  for (const [k, v] of Object.entries(out)) {
    appendFileSync(process.env.GITHUB_ENV, `${k}=${v}\n`)
  }
  console.log('Variables de la instancia efímera exportadas a $GITHUB_ENV:')
  for (const k of Object.keys(out)) console.log(`  - ${k}`)
} else {
  // Fuera de CI: se imprime el par clave=valor para evaluarlo en la shell.
  for (const [k, v] of Object.entries(out)) console.log(`export ${k}=${JSON.stringify(v)}`)
}

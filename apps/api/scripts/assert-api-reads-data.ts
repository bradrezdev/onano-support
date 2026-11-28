/**
 * Puerta de lectura: la API DEBE leer un dato de prueba dentro de un plazo
 * (S7). Si no lo logra, el job falla — un job que no lee nada y se ve verde
 * es peor que un job que se cae.
 *
 * El plazo existe porque `next dev` compila la ruta en la primera petición: un
 * fallo de compilación se manifestaría como un timeout, no como un error.
 *
 *   cd apps/api && pnpm tsx scripts/assert-api-reads-data.ts
 */
import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const API_URL = process.env.E2E_API_URL ?? 'http://localhost:3000'
const SB_URL = process.env.SUPABASE_URL
const PUBLISHABLE = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
const EMAIL = process.env.E2E_ADMIN_EMAIL ?? process.env.E2E_EMAIL
const PASSWORD = process.env.E2E_PASSWORD
const DEADLINE_MS = Number(process.env.E2E_READ_DEADLINE_MS ?? 60_000)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function main() {
  if (!SB_URL || !PUBLISHABLE || !EMAIL || !PASSWORD) {
    console.error('FALLO: faltan variables (SUPABASE_URL, clave publicable o credenciales).')
    process.exit(1)
  }

  const browser = createClient(SB_URL, PUBLISHABLE, { auth: { persistSession: false } })
  const { data: session, error: signInErr } = await browser.auth.signInWithPassword({
    email: EMAIL,
    password: PASSWORD,
  })
  if (signInErr) {
    console.error(`FALLO: no se pudo iniciar sesión: ${signInErr.message}`)
    process.exit(1)
  }
  const token = session.session?.access_token
  if (!token) {
    console.error('FALLO: la sesión no devolvió token.')
    process.exit(1)
  }

  const started = Date.now()
  let lastError = 'sin intentos'
  while (Date.now() - started < DEADLINE_MS) {
    try {
      const res = await fetch(`${API_URL}/api/contacts`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (res.ok) {
        const body = (await res.json()) as { data?: unknown[] }
        const rows = Array.isArray(body.data) ? body.data.length : 0
        if (rows > 0) {
          console.log(
            `OK · la API leyó ${rows} cliente(s) en ${Math.round((Date.now() - started) / 1000)}s.`,
          )
          return
        }
        lastError = `la respuesta vino vacía (${rows} filas)`
      } else {
        lastError = `HTTP ${res.status}`
      }
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e)
    }
    await sleep(2000)
  }

  console.error(`FALLO: la API no leyó un dato de prueba en ${DEADLINE_MS / 1000}s.`)
  console.error(`Último intento: ${lastError}`)
  process.exit(1)
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exitCode = 1
})

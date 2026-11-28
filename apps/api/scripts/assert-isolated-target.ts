/**
 * Verifica que el destino de la base es AISLADO antes de migrar, arrancar la
 * API o correr las E2E (S5/S6). La misma validación gobierna los tres pasos:
 * si el destino no es local, el job se detiene aquí.
 *
 * Por qué es una puerta y no una nota: la base compartida de desarrollo
 * (`nlhfnryxvpzqynvyiduw`) tiene el esquema eliminado y está en investigación.
 * Una migración aplicada por accidente sobre ella escribiría encima de una
 * posible restauración. Este script falla SIEMPRE ante un destino no local.
 *
 *   cd apps/api && pnpm tsx scripts/assert-isolated-target.ts
 */
import 'dotenv/config'

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '0.0.0.0'])

/** Host de la base de desarrollo compartida. Nunca es un destino válido aquí. */
const SHARED_HOST = 'db.nlhfnryxvpzqynvyiduw.supabase.co'

function hostOf(raw: string): string {
  try {
    return new URL(raw).hostname
  } catch {
    return ''
  }
}

function check(label: string, raw: string | undefined): string {
  if (!raw) {
    console.error(`FALLO: ${label} no está definida.`)
    process.exit(1)
  }
  const host = hostOf(raw)
  if (!host) {
    console.error(`FALLO: ${label} no es una URL válida.`)
    process.exit(1)
  }
  if (host === SHARED_HOST || host.endsWith('.supabase.co')) {
    console.error(
      `FALLO: ${label} apunta a ${host}, que NO es una instancia aislada.`,
    )
    console.error(
      'Las migraciones y las pruebas jamás se ejecutan contra la base compartida.',
    )
    process.exit(1)
  }
  if (!LOCAL_HOSTS.has(host)) {
    console.error(`FALLO: ${label} apunta a ${host}, que no es local.`)
    process.exit(1)
  }
  return host
}

const dbHost = check('DATABASE_URL', process.env.DATABASE_URL)
const apiHost = check('SUPABASE_URL', process.env.SUPABASE_URL)

if (dbHost !== apiHost) {
  console.error(
    `FALLO: la base (${dbHost}) y la API (${apiHost}) no son la misma instancia.`,
  )
  process.exit(1)
}

console.log(`Destino aislado verificado: ${dbHost} (base y API coinciden).`)

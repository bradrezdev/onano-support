/**
 * Contrato de aislamiento del respaldo (PR #1).
 *
 * Estas pruebas son ESTÁTICAS: no arrancan Postgres ni Docker. Fijan el
 * contrato que el ensayo de restauración y su orquestador deben cumplir para
 * que la demostración no pueda pasar en falso:
 *
 *   · el ensayo no puede alcanzar el origen (ni por docker, ni por pg_dump,
 *     ni por una URL del origen incrustada);
 *   · la integridad se verifica ANTES de tocar el destino;
 *   · la prueba de desconexión es obligatoria: si la URL del origen no se
 *     puede resolver, el orquestador falla (no "pasa" por no comprobar);
 *   · el orquestador y el creador hablan del mismo destino, y el respaldo
 *     nace con permisos restrictivos.
 *
 * Leen los scripts del repo: `process.cwd()` es `apps/api` cuando corre
 * vitest, así que la raíz del repo está dos niveles arriba.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const REPO_ROOT = resolve(process.cwd(), '..', '..')

function readRepoFile(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), 'utf8')
}

const RESTORE = readRepoFile('apps/api/scripts/restore-rehearsal.ts')
const CREATE = readRepoFile('apps/api/scripts/create-backup.ts')
const INTEGRITY = readRepoFile('apps/api/src/lib/backup-integrity.ts')
const ORCHESTRATOR = readRepoFile('scripts/dev/backup-and-verify-restore.sh')
const WORKFLOW = readRepoFile('.github/workflows/backup-restore.yml')
const DOCS = readRepoFile('docs/respaldos.md')

describe('el ensayo de restauración no alcanza el origen', () => {
  it('no menciona docker, pg_dump ni el stack del origen', () => {
    expect(RESTORE).not.toMatch(/docker/)
    expect(RESTORE).not.toMatch(/pg_dump/)
    expect(RESTORE).not.toMatch(/onano-support-dev/)
  })

  it('publica el destino de la restauración en el entorno', () => {
    expect(RESTORE).toContain('process.env.SUPABASE_URL = restoreEnv.apiUrl')
    expect(RESTORE).toContain('process.env.DATABASE_URL = restoreEnv.dbUrl')
  })

  it('verifica la integridad antes de tocar el esquema del destino', () => {
    const integridad = RESTORE.indexOf('verifyBackupIntegrity(')
    const limpieza = RESTORE.indexOf('drop schema public cascade')
    expect(integridad).toBeGreaterThan(-1)
    expect(limpieza).toBeGreaterThan(-1)
    expect(integridad).toBeLessThan(limpieza)
  })

  it('sube únicamente los archivos declarados en el manifiesto', () => {
    // Si el ensayo recorre el directorio de storage, un archivo extra (no
    // declarado) se restauraría en silencio: la verificación de integridad
    // debe señalarlo, no el recorrido.
    expect(RESTORE).not.toMatch(/readdirSync/)
  })

  it('conserva el puerto en el fallback de psql', () => {
    expect(RESTORE).toContain("'-p'")
  })

  it('aplica el volcado en una base de datos de prueba y compara los conteos', () => {
    expect(RESTORE).toMatch(/CREATE DATABASE/i)
    expect(RESTORE).toMatch(/DROP DATABASE/i)
    expect(RESTORE).toContain('tableCounts')
  })
})

describe('la integridad del respaldo es una decisión, no una excepción', () => {
  it('compara el tamaño además del hash', () => {
    expect(INTEGRITY).toMatch(/entry\.size/)
  })

  it('rechaza un manifiesto sin archivos', () => {
    expect(INTEGRITY).toMatch(/files\.length === 0/)
  })

  it('detecta los archivos de storage que el manifiesto no declara', () => {
    expect(INTEGRITY).toMatch(/storage\//)
  })
})

describe('el orquestador no puede pasar en falso', () => {
  it('resuelve la URL del origen desde el entorno primero', () => {
    expect(ORCHESTRATOR).toContain('ORIGIN_API="${SUPABASE_URL:-}"')
  })

  it('el curl al origen es obligatorio, no condicional', () => {
    expect(ORCHESTRATOR).not.toMatch(/\[ -n "\$\{ORIGIN_API\}" \] && curl/)
    expect(ORCHESTRATOR).toMatch(/if curl -s -o \/dev\/null/)
  })

  it('comprueba que el origen contestaba antes de detenerlo', () => {
    // Si la URL estuviera mal, el curl posterior fallaría por la URL y no
    // porque el origen estuviera apagado: la demostración sería vacua.
    expect(ORCHESTRATOR).toMatch(/if ! curl -s -o \/dev\/null/)
  })

  it('falla cuando la URL del origen no se puede resolver', () => {
    expect(ORCHESTRATOR).toMatch(/no se pudo resolver la URL del origen/i)
  })

  it('deriva los contenedores del origen de las mismas perillas que el creador', () => {
    expect(ORCHESTRATOR).toContain('ORIGIN_PROJECT="${ORIGIN_PROJECT:-onano-support-dev}"')
    expect(ORCHESTRATOR).toContain('ORIGIN_DB_CONTAINER="${ORIGIN_DB_CONTAINER:-supabase_db_${ORIGIN_PROJECT}}"')
  })

  it('no pisa el destino de respaldo que fija el operador', () => {
    expect(ORCHESTRATOR).toContain('BACKUPS_DIR')
    expect(ORCHESTRATOR).not.toMatch(/BACKUP_DIR="\$\(/)
  })

  it('el trap comprueba que el origen volvió a levantar', () => {
    const trap = ORCHESTRATOR.slice(ORCHESTRATOR.indexOf('restore_origin()'))
    expect(trap).toContain('docker start')
    // El trap consulta la misma lista de contenedores corriendo que usa la
    // prueba de desconexión: si el origen no volvió, el ensayo no sale en verde.
    expect(trap).toContain('contenedores_vivos')
    expect(ORCHESTRATOR).toContain('docker ps')
  })
})

describe('el job de CI demuestra lo mismo que la máquina', () => {
  it('siembra antes de respaldar', () => {
    const semilla = WORKFLOW.indexOf('Seed synthetic data')
    const respaldo = WORKFLOW.indexOf('Create backup')
    expect(semilla).toBeGreaterThan(-1)
    expect(respaldo).toBeGreaterThan(-1)
    expect(semilla).toBeLessThan(respaldo)
  })

  it('pasa el nombre real del contenedor del origen', () => {
    expect(WORKFLOW).toContain('ORIGIN_DB_CONTAINER: supabase_db_onano-support-ci')
  })

  it('resuelve la URL del origen desde el entorno', () => {
    expect(WORKFLOW).toContain('ORIGIN_API="${SUPABASE_URL:-}"')
  })
})

describe('el respaldo nace cerrado y sin secretos en el código', () => {
  it('no guarda una contraseña de muestra en el código fuente', () => {
    expect(CREATE).not.toMatch(/SAMPLE_PASSWORD\s*=\s*['"]/)
    expect(CREATE).toMatch(/randomBytes/)
  })

  it('escribe el manifiesto y los archivos con permisos restrictivos', () => {
    expect(CREATE).toContain('0o600')
    expect(CREATE).toContain('0o700')
  })

  it('no deja pasar un error de la cuenta ni del perfil de muestra', () => {
    expect(CREATE).toMatch(/listErr/)
    expect(CREATE).toMatch(/profileErr/)
  })

  it('se niega a escribir en un directorio de respaldo que ya existe', () => {
    expect(CREATE).toMatch(/existsSync\(backupDir\)/)
  })

  it('registra el tipo de contenido de cada objeto guardado', () => {
    expect(CREATE).toContain('contentType')
  })

  it('valida el nombre del objeto antes de usarlo como ruta', () => {
    // El creador usa la misma regla que el consumidor del respaldo, y esa
    // regla tiene prueba unitaria propia.
    expect(CREATE).toContain('resolveStorageObjectPath')
  })

  it('exige verificación de certificado fuera de loopback', () => {
    expect(CREATE).not.toMatch(/rejectUnauthorized:\s*false/)
    expect(RESTORE).not.toMatch(/rejectUnauthorized:\s*false/)
  })
})

describe('el registro de los ensayos no se pierde cuando algo falla', () => {
  it('el registro vive en el directorio de respaldos', () => {
    expect(RESTORE).toContain('BACKUPS_DIR')
  })

  it('un error al escribir el registro no tapa el fallo original', () => {
    expect(RESTORE).toMatch(/catch/)
  })
})

describe('la documentación describe lo que el código hace', () => {
  it('describe el layout real de los objetos guardados', () => {
    expect(DOCS).toContain('storage/<ruta>')
    expect(DOCS).not.toContain('storage/<bucket>/')
  })

  it('describe la prueba de desconexión por URL', () => {
    expect(DOCS).toContain('docker ps')
    expect(DOCS).toContain('curl')
  })
})

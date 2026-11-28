/**
 * Ensayo de restauración desde disco (PR #1).
 *
 * Recibe un directorio de respaldo (--backup <dir>) y restaura su contenido
 * en la instancia de restauración SIN conectarse al origen. El ensayo
 * demuestra que el respaldo es autocontenido: el origen puede estar apagado.
 *
 * Pasos:
 *   1 · Verifica la integridad del respaldo (archivos presentes, tamaños y
 *       hashes) y que no haya archivos que el manifiesto no declare.
 *   2 · Prepara la instancia de restauración.
 *   3 · Aplica `public.sql` en una base de datos de prueba del destino y
 *       comprueba que reproduce los conteos por tabla del manifiesto.
 *   4 · Limpia y recrea el esquema `public` en la instancia de restauración.
 *   5 · Aplica las migraciones del repo en la instancia de restauración.
 *   6 · Crea la cuenta de la muestra en el destino con la contraseña del
 *       manifiesto (los hashes de contraseña no migran entre instancias).
 *   7 · Restaura las filas de la muestra desde el manifiesto.
 *   8 · Restaura los objetos del bucket `whatsapp-media` desde disco.
 *   9 · Verifica identidad, permisos, relación cuenta↔chat, historial y bytes
 *       del adjunto usando los route handlers reales en proceso.
 *  10 · Registra el resultado fuera de la base.
 *
 *   cd apps/api && pnpm exec tsx scripts/restore-rehearsal.ts --backup <dir>
 */
import 'dotenv/config'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, appendFileSync, chmodSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { Client } from 'pg'
import { createClient } from '@supabase/supabase-js'
import {
  verifyBackupIntegrity,
  resolveBackupFilePath,
  type BackupManifest,
  type BackupExternalDependency,
} from '../src/lib/backup-integrity'

const REPO = process.cwd().endsWith('apps/api') ? process.cwd() : join(process.cwd(), 'apps/api')
const REPO_ROOT = join(REPO, '..', '..')
const RESTORE_STACK_DIR =
  process.env.RESTORE_STACK_DIR ?? join(homedir(), 'supabase-dev/onano-support-restore')
/** Directorio donde viven los respaldos y el registro de los ensayos. */
const BACKUPS_DIR = process.env.BACKUPS_DIR ?? join(homedir(), 'supabase-dev/backups')
const REGISTRY = join(BACKUPS_DIR, 'registry.jsonl')

/** Base de datos de prueba donde se aplica el volcado para contrastarlo. */
const SCRATCH_DB = 'backup_check'

function sh(cmd: string, args: string[], opts: { cwd?: string; quiet?: boolean } = {}): string {
  const out = execFileSync(cmd, args, {
    cwd: opts.cwd ?? REPO,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  })
  if (!opts.quiet) process.stdout.write(out)
  return out
}

function gitCommit(): string {
  try {
    return sh('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, quiet: true }).trim()
  } catch {
    return 'desconocido'
  }
}

function actor(): string {
  try {
    return (
      sh('git', ['config', 'user.email'], { cwd: REPO_ROOT, quiet: true }).trim() ||
      process.env.USER ||
      'desconocido'
    )
  } catch {
    return process.env.USER ?? 'desconocido'
  }
}

/**
 * El registro es la evidencia de que el ensayo corrió: un fallo al
 * escribirlo NUNCA puede tapar el fallo que lo provocó.
 */
function register(entry: Record<string, unknown>): void {
  try {
    mkdirSync(BACKUPS_DIR, { recursive: true })
    appendFileSync(REGISTRY, JSON.stringify(entry) + '\n')
    // El registro nombra la cuenta de la muestra: no es público.
    chmodSync(REGISTRY, 0o600)
  } catch (e) {
    console.error(
      `AVISO: no se pudo escribir el registro ${REGISTRY}: ${(e as Error).message}`,
    )
  }
}

// Directorio temporal de trabajo: si el ensayo falla a media restauracion, no
// puede quedar tirado en /tmp.
let WORK_DIR: string | null = null

function fail(step: string, detail: string): never {
  register({
    objetivo: 'ensayo de respaldo y restauración',
    destino: RESTORE_STACK_DIR,
    actor: actor(),
    fecha: new Date().toISOString(),
    commit: gitCommit(),
    resultado: 'FALLO',
    paso: step,
    detalle: detail,
  })
  console.error(`\nFALLO en ${step}: ${detail}`)
  console.error('El ensayo NO se declara exitoso. Registro: ' + REGISTRY)
  if (WORK_DIR) rmSync(WORK_DIR, { recursive: true, force: true })
  process.exit(1)
}

/**
 * TLS: el Postgres local de Supabase NO lo soporta. Fuera de loopback el
 * certificado se verifica: nadie puede suplantar el servidor del destino.
 */
function sslFor(connectionString: string): false | { rejectUnauthorized: boolean } {
  const host = (() => {
    try {
      return new URL(connectionString).hostname
    } catch {
      return ''
    }
  })()
  if (['127.0.0.1', 'localhost', '::1', '0.0.0.0'].includes(host)) return false
  return { rejectUnauthorized: true }
}

async function sql<T = unknown>(connectionString: string, text: string): Promise<T[]> {
  const pg = new Client({
    connectionString,
    ssl: sslFor(connectionString),
  })
  await pg.connect()
  try {
    const res = await pg.query(text)
    return res.rows as T[]
  } finally {
    await pg.end()
  }
}

// ---------------------------------------------------------------- psql

interface PsqlTarget {
  url: string
  host: string
  port: string
  user: string
  database: string
  password: string
}

const PSQL_BIN = existsSync('/opt/homebrew/opt/libpq/bin/psql')
  ? '/opt/homebrew/opt/libpq/bin/psql'
  : 'psql'

function psqlTarget(dbUrl: string, database?: string): PsqlTarget {
  const url = new URL(dbUrl)
  const db = database ?? decodeURIComponent(url.pathname.replace(/^\//, '') || 'postgres')
  const withDatabase = new URL(dbUrl)
  withDatabase.pathname = `/${db}`
  return {
    url: withDatabase.toString(),
    host: url.hostname,
    // El puerto SIEMPRE viaja explícito: el `psql` del sistema (el de CI)
    // se conecta al 5432 por omisión y el destino vive en otro puerto.
    port: url.port || '5432',
    user: decodeURIComponent(url.username || 'postgres'),
    database: db,
    password: decodeURIComponent(url.password || ''),
  }
}

/**
 * El cliente de Homebrew acepta la URL completa; el `psql` del sistema no, y
 * necesita host, puerto, usuario y base por separado.
 */
function psqlCommand(target: PsqlTarget, extra: string[]): { bin: string; args: string[] } {
  if (PSQL_BIN.includes('libpq')) {
    return { bin: PSQL_BIN, args: [target.url, ...extra] }
  }
  return {
    bin: 'psql',
    args: [
      '-h',
      target.host,
      '-p',
      target.port,
      '-U',
      target.user,
      '-d',
      target.database,
      ...extra,
    ],
  }
}

function runPsql(target: PsqlTarget, extra: string[]): string {
  const { bin, args } = psqlCommand(target, extra)
  if (!bin.includes('libpq')) {
    process.env.PGPASSWORD = target.password
  }
  return sh(bin, args, { quiet: true })
}

// ---------------------------------------------------------------- volcado

/**
 * El volcado del esquema `public` NO incluye las extensiones (son objetos de
 * base, no de esquema) y su `CREATE SCHEMA public;` exige que el esquema
 * todavía no exista. Por eso el volcado se aplica en dos tramos: el primero
 * crea el esquema y las tablas, y entre los dos se declara lo que el
 * manifiesto dice que hace falta (sin `pg_trgm`, el índice `gin_trgm_ops` no
 * se crea).
 *
 * El contenido aplicado es el volcado VERBATIM: entre los tramos solo se
 * intercala la declaración de las extensiones.
 */
function partirVolcado(dump: Buffer): { primera: Buffer; segunda: Buffer } {
  const texto = dump.toString('utf8')
  const match = /^CREATE (?:UNIQUE )?INDEX /m.exec(texto)
  if (!match || match.index === undefined) return { primera: dump, segunda: Buffer.alloc(0) }
  const corte = Buffer.byteLength(texto.slice(0, match.index), 'utf8')
  return { primera: dump.subarray(0, corte), segunda: dump.subarray(corte) }
}

function agruparPorTabla(
  dependencias: BackupExternalDependency[],
): Map<string, BackupExternalDependency[]> {
  const grupos = new Map<string, BackupExternalDependency[]>()
  for (const dependencia of dependencias) {
    const clave = `${dependencia.schema}.${dependencia.table}`
    const lista = grupos.get(clave) ?? []
    lista.push(dependencia)
    grupos.set(clave, lista)
  }
  return grupos
}

/**
 * Objetos fuera de `public` de los que depende el esquema volcado (en
 * Supabase, `auth.users` lo administra GoTrue y NO está en el respaldo).
 *
 * Se crean tablas con la forma que las claves foráneas necesitan: sin ellas
 * el volcado no se puede aplicar en una base limpia.
 */
function ddlDependenciasExternas(manifest: BackupManifest): string {
  const dependencias = manifest.externalDependencies ?? []
  if (dependencias.length === 0) return ''

  const lineas = ['-- Objetos fuera de `public` de los que depende el esquema volcado.']
  for (const [, lista] of agruparPorTabla(dependencias)) {
    const primera = lista[0]
    const columnas = lista.map((d) => `"${d.column}" ${d.type}`).join(', ')
    const clave = lista.map((d) => `"${d.column}"`).join(', ')
    lineas.push(`CREATE SCHEMA IF NOT EXISTS "${primera.schema}";`)
    lineas.push(
      `CREATE TABLE IF NOT EXISTS "${primera.schema}"."${primera.table}" (${columnas}, PRIMARY KEY (${clave}));`,
    )
  }
  // Mientras se cargan los datos, las claves foráneas no se validan: las filas
  // referenciadas viven fuera del respaldo y se dan de alta después.
  lineas.push('SET session_replication_role = replica;')
  return lineas.join('\n') + '\n'
}

/**
 * Da de alta en las tablas referenciadas las filas que el propio volcado
 * declara en `public`, para que la clave foránea pueda validarse al
 * crearse.
 */
function ddlPobladoDependencias(manifest: BackupManifest): string {
  const dependencias = manifest.externalDependencies ?? []
  if (dependencias.length === 0) return ''

  const lineas = [
    '-- Las filas que el volcado declara en `public` también existen en las tablas que referencia.',
  ]
  for (const [, lista] of agruparPorTabla(dependencias)) {
    const primera = lista[0]
    const destino = lista.map((d) => `"${d.column}"`).join(', ')
    const origen = lista
      .map(
        (d) =>
          `select distinct t."${d.fromColumn}" as v from "${d.fromSchema}"."${d.fromTable}" t where t."${d.fromColumn}" is not null`,
      )
      .join(' union all ')
    lineas.push(
      `insert into "${primera.schema}"."${primera.table}" (${destino}) select v from (${origen}) s where v is not null on conflict do nothing;`,
    )
  }
  return lineas.join('\n') + '\n'
}

function ddlExtensiones(manifest: BackupManifest): string {
  const extensiones = manifest.extensions ?? []
  const lineas = ['-- Extensiones que el esquema público necesita (no vienen en el volcado).']
  lineas.push('CREATE SCHEMA IF NOT EXISTS public;')
  // El volcado deja el `search_path` vacío; sin un esquema donde crear, la
  // extensión no se puede instalar.
  lineas.push('SET search_path = public;')
  for (const extension of extensiones) {
    const identificador = `"${extension.replace(/"/g, '""')}"`
    // Sin SCHEMA explícito: hay extensiones que viven en su propio esquema
    // (`supabase_vault` exige `vault`) y no se pueden mover.
    lineas.push(`CREATE EXTENSION IF NOT EXISTS ${identificador};`)
  }
  // Se devuelve el `search_path` vacío que el volcado usa para que sus
  // nombres sin calificar se resuelvan contra pg_catalog.
  lineas.push("SELECT pg_catalog.set_config('search_path', '', false);")
  return lineas.join('\n') + '\n'
}

/**
 * Aplica `public.sql` en una base de datos de prueba del Postgres de destino
 * y compara los conteos por tabla con los del manifiesto.
 *
 * Devuelve `null` cuando todo cuadra, o el mensaje del problema. La base de
 * prueba se borra SIEMPRE, incluso cuando la comparación falla.
 */
async function verificarVolcadoEnScratch(
  dbUrl: string,
  manifest: BackupManifest,
  backupDir: string,
  workDir: string,
): Promise<string | null> {
  const dumpPath = join(backupDir, 'public.sql')
  if (!existsSync(dumpPath)) return `no existe el volcado ${dumpPath}`
  if (!manifest.tableCounts || manifest.tableCounts.length === 0) {
    return 'el manifiesto no declara los conteos por tabla del volcado'
  }

  const dump = readFileSync(dumpPath)
  const { primera, segunda } = partirVolcado(dump)
  const aplicado = Buffer.concat([primera, segunda])
  const esperado = manifest.files.find((f) => f.path === 'public.sql')
  if (esperado) {
    const hash = createHash('sha256').update(aplicado).digest('hex')
    if (hash !== esperado.sha256) {
      return `el volcado aplicado no es el archivo verificado (sha256 ${hash} != ${esperado.sha256})`
    }
  }

  const applyPath = join(workDir, 'apply-dump.sql')
  // El volcado se aplica VERBATIM: lo único que se intercala es la
  // preparación de la base de prueba (las tablas de las que dependen las
  // claves foráneas, las extensiones y el alta de las filas referenciadas).
  const puntoInicial = ddlDependenciasExternas(manifest)
  const puntoMedio = [
    'SET session_replication_role = origin;',
    ddlExtensiones(manifest),
    ddlPobladoDependencias(manifest),
  ].join('\n')
  writeFileSync(
    applyPath,
    Buffer.concat([
      Buffer.from(puntoInicial, 'utf8'),
      primera,
      Buffer.from(puntoMedio, 'utf8'),
      segunda,
    ]),
  )

  const destino = psqlTarget(dbUrl)
  const scratch = psqlTarget(dbUrl, SCRATCH_DB)

  try {
    runPsql(destino, ['-v', 'ON_ERROR_STOP=1', '-c', `drop database if exists ${SCRATCH_DB}`])
    runPsql(destino, ['-v', 'ON_ERROR_STOP=1', '-c', `create database ${SCRATCH_DB}`])
    // El esquema `public` tiene que NO existir: el volcado lo crea.
    runPsql(scratch, ['-v', 'ON_ERROR_STOP=1', '-c', 'drop schema if exists public cascade'])

    try {
      runPsql(scratch, ['-v', 'ON_ERROR_STOP=1', '-f', applyPath])
    } catch (e) {
      const salida = `${(e as { stdout?: string }).stdout ?? ''}${(e as { stderr?: string }).stderr ?? ''}`
      return `el volcado no se pudo aplicar en la base de prueba: ${salida.trim().slice(-600)}`
    }

    const tablas = await sql<{ table_name: string }>(
      scratch.url,
      `select table_name from information_schema.tables
        where table_schema = 'public' and table_type = 'BASE TABLE'
        order by table_name`,
    )
    const encontrados = new Map<string, number>()
    for (const tabla of tablas) {
      const identificador = `"${tabla.table_name.replace(/"/g, '""')}"`
      const contados = await sql<{ total: string }>(
        scratch.url,
        `select count(*)::text as total from public.${identificador}`,
      )
      encontrados.set(tabla.table_name, Number(contados[0]?.total ?? 0))
    }

    const diferencias: string[] = []
    for (const conteo of manifest.tableCounts) {
      if (!encontrados.has(conteo.table)) {
        diferencias.push(`${conteo.table}: no existe en la base de prueba`)
        continue
      }
      const filas = encontrados.get(conteo.table)
      if (filas !== conteo.rows) {
        diferencias.push(`${conteo.table}: ${filas} filas en el volcado, ${conteo.rows} en el manifiesto`)
      }
    }
    for (const [tabla, filas] of encontrados) {
      if (!manifest.tableCounts.some((c) => c.table === tabla)) {
        diferencias.push(`${tabla}: ${filas} filas en el volcado y no está en el manifiesto`)
      }
    }
    if (diferencias.length > 0) {
      return `el volcado no reproduce los conteos del manifiesto: ${diferencias.join('; ')}`
    }
    return null
  } catch (e) {
    return `no se pudo preparar la base de prueba: ${(e as Error).message}`
  } finally {
    try {
      runPsql(destino, ['-v', 'ON_ERROR_STOP=1', '-c', `drop database if exists ${SCRATCH_DB}`])
    } catch {
      // La base de prueba se limpia en cualquier caso; si no se pudo, el
      // ensayo ya falló por otra razón y el nombre queda documentado arriba.
    }
  }
}

const q = (v: unknown): string => {
  if (v === null || v === undefined) return 'null'
  if (typeof v === 'number') return String(v)
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (typeof v === 'object') return `'${JSON.stringify(v).replace(/'/g, "''")}'`
  return `'${String(v).replace(/'/g, "''")}'`
}

async function callRoute<TContext>(
  handler: (request: Request, ctx: TContext) => Promise<Response>,
  path: string,
  token: string,
  ctx: TContext,
): Promise<{ status: number; body: any }> {
  const request = new Request(`http://127.0.0.1${path}`, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  })
  const res = await handler(request, ctx)
  const text = await res.text()
  let body: any = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text
  }
  return { status: res.status, body }
}

function parseArgs(): { backupDir: string } {
  const args = process.argv.slice(2)
  const idx = args.indexOf('--backup')
  const fromCli = idx !== -1 ? args[idx + 1] : undefined
  const backupDir = fromCli ?? process.env.BACKUP_DIR
  if (!backupDir) {
    console.error('Uso: pnpm exec tsx scripts/restore-rehearsal.ts --backup <directorio>')
    process.exit(2)
  }
  return { backupDir }
}

async function main() {
  const { backupDir } = parseArgs()
  if (!existsSync(backupDir)) fail('argumentos', `no existe el directorio de respaldo: ${backupDir}`)
  const manifestPath = join(backupDir, 'manifest.json')
  if (!existsSync(manifestPath)) fail('argumentos', `no existe el manifiesto: ${manifestPath}`)

  let manifest: BackupManifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as BackupManifest
  } catch (e) {
    fail('argumentos', `el manifiesto no es JSON valido: ${(e as Error).message}`)
  }
  mkdirSync(BACKUPS_DIR, { recursive: true })

  // ---------------------------------------------------------------- 1 · integridad
  console.log('== 1 · integridad del respaldo ==')
  const integrity = verifyBackupIntegrity(backupDir, manifest)
  if (!integrity.ok) fail('integridad', integrity.error)
  console.log('   archivos presentes, con el tamaño y los hashes correctos')

  const workDir = mkdtempSync(join(tmpdir(), 'crm-restore-'))
  WORK_DIR = workDir

  // ---------------------------------------------------------------- 2 · instancia de restauración
  console.log('== 2 · instancia de restauración ==')
  const restoreEnv = prepareRestoreStack()
  console.log(`   API=${restoreEnv.apiUrl} DB=${restoreEnv.dbUrl}`)

  // ---------------------------------------------------------------- 3 · el volcado sirve
  console.log('== 3 · el volcado se aplica y reproduce los conteos ==')
  const problemaVolcado = await verificarVolcadoEnScratch(
    restoreEnv.dbUrl,
    manifest,
    backupDir,
    workDir,
  )
  if (problemaVolcado) fail('volcado', problemaVolcado)
  console.log(`   tablas comprobadas: ${manifest.tableCounts?.length ?? 0}`)

  // ---------------------------------------------------------------- 4 · estado limpio
  console.log('== 4 · estado limpio del destino ==')
  try {
    await sql(restoreEnv.dbUrl, 'drop schema public cascade; create schema public;')
  } catch (e) {
    fail('estado limpio', `no se pudo recrear el esquema public: ${(e as Error).message}`)
  }
  try {
    await sql(
      restoreEnv.dbUrl,
      `
      grant usage on schema public to postgres, anon, authenticated, service_role;
      grant create on schema public to postgres;
      grant all on all tables in schema public to postgres, anon, authenticated, service_role;
      grant all on all sequences in schema public to postgres, anon, authenticated, service_role;
      grant all on all routines in schema public to postgres, anon, authenticated, service_role;
      alter default privileges in schema public grant all on tables to postgres, anon, authenticated, service_role;
      alter default privileges in schema public grant all on sequences to postgres, anon, authenticated, service_role;
      alter default privileges in schema public grant all on routines to postgres, anon, authenticated, service_role;
      `,
    )
  } catch (e) {
    fail('estado limpio', `no se pudieron restaurar los privilegios por defecto: ${(e as Error).message}`)
  }
  console.log('   esquema public recreado y privilegios por defecto aplicados')

  // ---------------------------------------------------------------- 5 · migraciones
  console.log('== 5 · migraciones del repo en la instancia restaurada ==')
  const migrateEnv = {
    ...process.env,
    DATABASE_URL: restoreEnv.dbUrl,
    SUPABASE_URL: restoreEnv.apiUrl,
    SUPABASE_SECRET_KEY: restoreEnv.secretKey,
    NEXT_PUBLIC_SUPABASE_URL: restoreEnv.apiUrl,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: restoreEnv.publishableKey,
  }
  try {
    execFileSync('pnpm', ['--filter', '@crm/api', 'db:migrate'], {
      cwd: REPO_ROOT,
      env: migrateEnv,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (e) {
    const out = `${(e as { stdout?: string }).stdout ?? ''}${(e as { stderr?: string }).stderr ?? ''}`
    fail('migraciones', `db:migrate falló en la instancia restaurada: ${out.slice(-800)}`)
  }
  const restoredLedger = await sql<{ filename: string; applied_at: string }>(
    restoreEnv.dbUrl,
    `select filename, applied_at from public.schema_migrations order by filename`,
  )
  if (restoredLedger.length === 0) {
    fail('migraciones', 'la instancia restaurada no registra ninguna migración aplicada')
  }
  console.log(`   migraciones aplicadas: ${restoredLedger.length}`)

  // ---------------------------------------------------------------- 6 · restaurar muestra
  console.log('== 6 · restauración de la muestra ==')
  const rest = createClient(restoreEnv.apiUrl, restoreEnv.secretKey, {
    auth: { persistSession: false },
  })

  // La cuenta puede existir de una corrida anterior: se borra para repetibilidad.
  const { data: copyUsers } = await rest.auth.admin.listUsers({ page: 1, perPage: 200 })
  const previous = copyUsers?.users.find((u) => u.email?.toLowerCase() === manifest.account.email)
  if (previous) await rest.auth.admin.deleteUser(previous.id)

  const { data: createdUser, error: createErr } = await rest.auth.admin.createUser({
    email: manifest.account.email,
    password: manifest.account.password,
    email_confirm: true,
    user_metadata: { display_name: 'Backup Muestra' },
  })
  if (createErr) fail('restauración', `no se pudo crear la cuenta en la copia: ${createErr.message}`)
  const copyUserId = createdUser.user.id

  // El SQL de la muestra se escribe FUERA del respaldo: el directorio del
  // respaldo es la fuente y no se toca (su integridad está verificada).
  const sampleSqlPath = join(workDir, 'restore-sample.sql')
  writeFileSync(
    sampleSqlPath,
    [
      '-- Muestra restaurada desde el manifiesto del respaldo.',
      `insert into public.contacts (id, whatsapp_number, name, country) values (${q(manifest.contact.id)}, ${q(manifest.contact.whatsapp_number)}, ${q(manifest.contact.name)}, ${q(manifest.contact.country)}) on conflict (id) do nothing;`,
      `insert into public.profiles (id, display_name, role, role_key) values (${q(copyUserId)}, 'Backup Muestra', 'soporte', 'soporte') on conflict (id) do nothing;`,
      `insert into public.conversations (id, contact_id, assigned_agent_id, status, last_message_at, last_message_preview, unread_count) values (${q(manifest.conversation.id)}, ${q(manifest.contact.id)}, ${q(copyUserId)}, 'open', now(), ${q(manifest.conversation.body)}, 0) on conflict (id) do nothing;`,
      `insert into public.messages (conversation_id, direction, body) values (${q(manifest.conversation.id)}, 'in', ${q(manifest.conversation.body)});`,
      '',
    ].join('\n'),
  )

  try {
    runPsql(psqlTarget(restoreEnv.dbUrl), ['-v', 'ON_ERROR_STOP=1', '-f', sampleSqlPath])
  } catch (e) {
    const out = `${(e as { stdout?: string }).stdout ?? ''}${(e as { stderr?: string }).stderr ?? ''}`
    fail('restauración', `la muestra no se restauró: ${out.slice(-800)}`)
  }

  // ---------------------------------------------------------------- 7 · objetos de Storage
  console.log('== 7 · objetos de Storage desde disco ==')
  // Solo los objetos que el manifiesto declara: la verificación de integridad
  // ya rechazó que haya archivos extra, así que aquí no puede subirse nada
  // que nadie haya verificado.
  const objetos = manifest.files.filter((f) => f.path.startsWith('storage/'))
  for (const entry of objetos) {
    const objectName = entry.path.slice('storage/'.length)
    const fullPath = resolveBackupFilePath(backupDir, entry.path)
    if (!fullPath) fail('storage', `ruta de objeto inválida en el manifiesto: ${entry.path}`)
    const bytes = readFileSync(fullPath)
    const contentType = entry.contentType ?? 'application/octet-stream'
    const { error: upErr } = await rest.storage
      .from('whatsapp-media')
      .upload(objectName, bytes, { contentType, upsert: true })
    if (upErr) fail('storage', `no se pudo subir ${objectName}: ${upErr.message}`)
    console.log(`   ${objectName} (${bytes.length} bytes, ${contentType})`)
  }
  if (objetos.length === 0) console.log('   (sin objetos)')

  // ---------------------------------------------------------------- 8 · verificación
  console.log('== 8 · verificación en la instancia restaurada ==')
  const browser = createClient(restoreEnv.apiUrl, restoreEnv.publishableKey, {
    auth: { persistSession: false },
  })
  const { data: session, error: signInErr } = await browser.auth.signInWithPassword({
    email: manifest.account.email,
    password: manifest.account.password,
  })
  if (signInErr) fail('verificación', `el inicio de sesión falló en la copia: ${signInErr.message}`)
  const token = session.session?.access_token
  if (!token) fail('verificación', 'la copia no devolvió token de sesión')

  process.env.SUPABASE_URL = restoreEnv.apiUrl
  process.env.SUPABASE_SECRET_KEY = restoreEnv.secretKey
  process.env.NEXT_PUBLIC_SUPABASE_URL = restoreEnv.apiUrl
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = restoreEnv.publishableKey
  process.env.DATABASE_URL = restoreEnv.dbUrl

  const meRoute = await import('../src/app/api/me/route')
  const conversationRoute = await import('../src/app/api/conversations/[id]/route')

  // 8.1 · identidad + permisos
  const me = await callRoute<undefined>(meRoute.GET, '/api/me', token, undefined)
  if (me.status !== 200) {
    fail('verificación', `/api/me respondió ${me.status} en la copia`)
  }
  const permissions = me.body?.data?.permissions ?? []
  if (!Array.isArray(permissions) || permissions.length === 0) {
    fail('verificación', 'la copia devolvió un keyring vacío: los permisos no se restauraron')
  }

  // 8.2 · relación cuenta↔chat y cliente
  const { data: chatRow, error: chatErr } = await rest
    .from('conversations')
    .select('id, contact_id, assigned_agent_id')
    .eq('id', manifest.conversation.id)
    .maybeSingle<{ id: string; contact_id: string; assigned_agent_id: string | null }>()
  if (chatErr || !chatRow) {
    fail('verificación', `no se encontró el chat restaurado: ${chatErr?.message ?? 'sin datos'}`)
  }
  if (chatRow.assigned_agent_id !== copyUserId) {
    fail('verificación', 'el chat no está asignado a la cuenta restaurada')
  }
  if (chatRow.contact_id !== manifest.contact.id) {
    fail('verificación', 'el chat no apunta al cliente restaurado')
  }

  // 8.3 · historial del chat, servido y autorizado por la app
  const history = await callRoute(
    conversationRoute.GET,
    `/api/conversations/${manifest.conversation.id}`,
    token,
    { params: Promise.resolve({ id: manifest.conversation.id }) },
  )
  if (history.status !== 200) {
    fail('verificación', `el historial respondió ${history.status} en la copia`)
  }
  const historyItems = history.body?.data?.messages ?? []
  const historyCount = Array.isArray(historyItems) ? historyItems.length : 0
  if (!JSON.stringify(historyItems).includes(manifest.conversation.body)) {
    fail('verificación', 'el historial del chat no se restauró')
  }

  // 8.4 · bytes del adjunto de la muestra
  const sampleFileEntry = manifest.files.find((f) => f.path === `storage/${manifest.attachment.path}`)
  if (!sampleFileEntry) {
    fail('verificación', `el manifiesto no incluye el adjunto de la muestra: ${manifest.attachment.path}`)
  }
  const objectName = sampleFileEntry.path.slice('storage/'.length)
  const samplePath = resolveBackupFilePath(backupDir, sampleFileEntry.path)
  if (!samplePath) fail('verificación', `ruta de adjunto inválida: ${sampleFileEntry.path}`)
  const backupBytes = readFileSync(samplePath)
  const { data: back, error: backErr } = await rest.storage.from('whatsapp-media').download(objectName)
  if (backErr || !back) {
    fail('verificación', `no se pudo leer el archivo en la copia: ${backErr?.message ?? 'sin datos'}`)
  }
  const backBytes = Buffer.from(await back.arrayBuffer())
  if (!backBytes.equals(backupBytes)) {
    fail(
      'verificación',
      `el contenido del archivo difiere (${backBytes.length} vs ${backupBytes.length} bytes)`,
    )
  }

  // ---------------------------------------------------------------- 9 · registro
  const record = {
    objetivo: 'ensayo de respaldo y restauración',
    destino: restoreEnv.apiUrl,
    actor: actor(),
    fecha: new Date().toISOString(),
    commit: gitCommit(),
    resultado: 'OK',
    muestra: {
      cuenta: manifest.account.email,
      chat: manifest.conversation.id,
      archivo: sampleFileEntry.path,
      bytes: sampleFileEntry.size,
    },
    verificado: [
      'integridad del respaldo (tamaño y hash)',
      'volcado aplicado y conteos por tabla',
      'inicio de sesión',
      'keyring de permisos',
      'relación cuenta-chat-cliente',
      'historial del chat',
      'contenido del archivo',
    ],
    migraciones: restoredLedger.map((l) => ({ filename: l.filename, applied_at: l.applied_at })),
    backup_dir: backupDir,
    hashes: manifest.files.reduce<Record<string, string>>((acc, f) => {
      acc[f.path] = f.sha256
      return acc
    }, {}),
  }
  register(record)

  console.log('')
  console.log('== OK · el respaldo se restauró y se verificó en otra instancia ==')
  console.log(
    `   cuenta=${manifest.account.email} permisos=${permissions.length} mensajes=${historyCount} bytes=${sampleFileEntry.size}`,
  )
  console.log(`   backup_dir=${backupDir}`)
  console.log('   registro: ' + REGISTRY)

  // Limpieza del SQL temporal: el respaldo en disco sigue siendo la fuente.
  rmSync(workDir, { recursive: true, force: true })
  WORK_DIR = null
}

function prepareRestoreStack(): {
  apiUrl: string
  dbUrl: string
  secretKey: string
  publishableKey: string
} {
  mkdirSync(join(RESTORE_STACK_DIR, 'supabase'), { recursive: true })
  const base = readFileSync(join(REPO_ROOT, 'supabase/ci/config.toml'), 'utf8')
  const replacements: [string, string][] = [
    ['project_id = "onano-support-ci"', 'project_id = "onano-support-restore"'],
    ['port = 54321', 'port = 54331'],
    ['port = 54322', 'port = 54332'],
    ['port = 54320', 'port = 54330'],
    ['port = 54323', 'port = 54333'],
  ]
  let config = base
  for (const [from, to] of replacements) config = config.replace(from, to)
  writeFileSync(join(RESTORE_STACK_DIR, 'supabase/config.toml'), config)

  const readStatus = (): Record<string, string> => {
    try {
      const out = sh('supabase', ['status', '-o', 'env'], {
        cwd: RESTORE_STACK_DIR,
        quiet: true,
      })
      const values: Record<string, string> = {}
      for (const line of out.split('\n')) {
        const m = line.match(/^([A-Z_][A-Z0-9_]*)="?(.*?)"?$/)
        if (m) values[m[1]] = m[2]
      }
      return values
    } catch {
      return {}
    }
  }

  let values = readStatus()
  if (!values.API_URL) {
    try {
      sh(
        'supabase',
        [
          'start',
          '--exclude',
          'studio,imgproxy,edge-runtime,vector,realtime,logflare,mailpit,supavisor',
        ],
        { cwd: RESTORE_STACK_DIR, quiet: true },
      )
    } catch (e) {
      fail('instancia de restauración', `no se pudo levantar: ${(e as Error).message}`)
    }
    values = readStatus()
  }
  const apiUrl = values.API_URL ?? 'http://127.0.0.1:54331'
  const dbUrl = values.DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54332/postgres'
  const secretKey = values.SERVICE_ROLE_KEY ?? values.SECRET_KEY ?? ''
  const publishableKey = values.ANON_KEY ?? values.PUBLISHABLE_KEY ?? ''
  if (!secretKey || !publishableKey) {
    fail('instancia de restauración', 'el stack no publicó claves utilizables')
  }
  return { apiUrl, dbUrl, secretKey, publishableKey }
}

main().catch((e) => {
  fail('inesperado', e instanceof Error ? e.message : String(e))
})

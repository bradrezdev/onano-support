/**
 * Crea un respaldo completo de la instancia de desarrollo en un directorio
 * del disco: esquema `public`, objetos del bucket `whatsapp-media` y un
 * manifiesto con hashes sha256.
 *
 * El respaldo es autocontenido: la restauración no necesita conectarse al
 * origen, solo leer los archivos de este directorio.
 *
 *   cd apps/api && pnpm exec tsx scripts/create-backup.ts
 *
 * Perillas (las mismas que honra `scripts/dev/backup-and-verify-restore.sh`):
 *   BACKUPS_DIR        · directorio donde se crean los respaldos.
 *   BACKUP_DIR         · directorio exacto de este respaldo (no se crea otro).
 *   ORIGIN_PROJECT     · id del proyecto del stack de origen (onano-support-dev).
 *   ORIGIN_DB_CONTAINER· contenedor de Postgres del origen.
 *   ORIGIN_STACK_DIR   · directorio del stack de origen.
 */
import 'dotenv/config'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync, existsSync, readFileSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createHash, randomBytes } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { Client } from 'pg'
import { resolveStorageObjectPath } from '../src/lib/backup-integrity'

const REPO = process.cwd().endsWith('apps/api') ? process.cwd() : join(process.cwd(), 'apps/api')
const REPO_ROOT = join(REPO, '..', '..')
const BACKUPS_DIR = process.env.BACKUPS_DIR ?? join(homedir(), 'supabase-dev/backups')
/** Destino exacto de este respaldo; si viene vacío se genera uno con marca de tiempo. */
const BACKUP_DIR_OVERRIDE = process.env.BACKUP_DIR ?? ''
const ORIGIN_PROJECT = process.env.ORIGIN_PROJECT ?? 'onano-support-dev'
const ORIGIN_STACK_DIR =
  process.env.ORIGIN_STACK_DIR ?? join(homedir(), 'supabase-dev', ORIGIN_PROJECT)
const ORIGIN_DB_CONTAINER = process.env.ORIGIN_DB_CONTAINER ?? `supabase_db_${ORIGIN_PROJECT}`

const DEV_API = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321'
const DEV_KEY = process.env.SUPABASE_SECRET_KEY ?? ''
const DEV_DB = process.env.DATABASE_URL ?? ''

const SAMPLE_EMAIL = 'backup.rehearsal@example.test'
const SAMPLE_BODY = 'Mensaje de muestra para el ensayo de respaldo.'
const SAMPLE_FILE_NAME = 'backup-rehearsal.txt'
const SAMPLE_FILE_CONTENT = 'Contenido de muestra del ensayo de respaldo.\nsegunda línea\n'

/** El respaldo contiene credenciales: el directorio se crea cerrado (700) y sus archivos en 600. */
const DIR_MODE = 0o700
const FILE_MODE = 0o600

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

function instanceId(): string {
  try {
    const configPath = join(ORIGIN_STACK_DIR, 'supabase/config.toml')
    if (existsSync(configPath)) {
      const config = readFileSync(configPath, 'utf8')
      const match = config.match(/^project_id\s*=\s*"([^"]+)"/m)
      if (match) return match[1]
    }
  } catch {
    // fallthrough
  }
  try {
    return new URL(DEV_API).hostname
  } catch {
    return 'desconocido'
  }
}

function fail(step: string, detail: string): never {
  console.error(`\nFALLO en ${step}: ${detail}`)
  process.exit(1)
}

/**
 * TLS: el Postgres local de Supabase NO lo soporta y rechaza la conexión si
 * se le pide ("The server does not support SSL connections"). Fuera de
 * loopback, el certificado se verifica: un intermediario no puede suplantar
 * el servidor ni inyectar un ledger de migraciones falso en el manifiesto.
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
  const pg = new Client({ connectionString, ssl: sslFor(connectionString) })
  await pg.connect()
  try {
    const res = await pg.query(text)
    return res.rows as T[]
  } finally {
    await pg.end()
  }
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function sha256Bytes(input: Buffer): string {
  return createHash('sha256').update(input).digest('hex')
}

/**
 * Contraseña de la cuenta de muestra: se genera al vuelo y NO vive en el
 * código. El manifiesto es el único lugar donde queda (es el artefacto que
 * permite recrear la cuenta en el destino).
 */
function generarPasswordMuestra(): string {
  return `Bp-${randomBytes(18).toString('base64url')}`
}

/**
 * Convierte el nombre de un objeto de Storage en una ruta dentro del
 * directorio `storage/`. Un nombre con segmentos `..` o una ruta absoluta
 * escribiría fuera del respaldo: se rechaza (misma regla que aplica el
 * consumidor del respaldo).
 */
function rutaDeObjeto(storageDir: string, objectName: string): string {
  const dest = resolveStorageObjectPath(storageDir, objectName)
  if (!dest) {
    fail('storage', `el nombre del objeto sale del directorio de respaldo: ${objectName}`)
  }
  return dest
}

function escribirArchivoCerrado(path: string, data: string | Buffer): void {
  writeFileSync(path, data, { mode: FILE_MODE })
  chmodSync(path, FILE_MODE)
}

function crearDirectorioCerrado(path: string): void {
  mkdirSync(path, { recursive: true, mode: DIR_MODE })
  chmodSync(path, DIR_MODE)
}

async function main() {
  if (!DEV_KEY || !DEV_DB) {
    fail('preparación', 'faltan SUPABASE_SECRET_KEY o DATABASE_URL del entorno de desarrollo')
  }

  // Marca de tiempo con milisegundos: dos respaldos en el mismo segundo no
  // pueden pisarse. Y nunca se escribe en un directorio que ya existe.
  const stamp = new Date().toISOString().replace(/[-:.]/g, '').replace('Z', '')
  const backupDir = BACKUP_DIR_OVERRIDE || join(BACKUPS_DIR, `backup-${stamp}`)
  if (existsSync(backupDir)) {
    fail('preparación', `el directorio de respaldo ya existe: ${backupDir}`)
  }
  const storageDir = join(backupDir, 'storage')
  crearDirectorioCerrado(backupDir)
  crearDirectorioCerrado(storageDir)

  const dev = createClient(DEV_API, DEV_KEY, { auth: { persistSession: false } })

  // ---------------------------------------------------------------- 1 · muestra
  console.log('== 1 · muestra sintética en el origen ==')
  const { data: listed, error: listErr } = await dev.auth.admin.listUsers({ page: 1, perPage: 200 })
  if (listErr) fail('preparación', `no se pudo listar las cuentas del origen: ${listErr.message}`)
  const existing = listed?.users.find((u) => u.email?.toLowerCase() === SAMPLE_EMAIL)
  if (existing) await dev.auth.admin.deleteUser(existing.id)

  const samplePassword = generarPasswordMuestra()
  const { data: created, error: createErr } = await dev.auth.admin.createUser({
    email: SAMPLE_EMAIL,
    password: samplePassword,
    email_confirm: true,
    user_metadata: { display_name: 'Backup Muestra' },
  })
  if (createErr) fail('preparación', `no se pudo crear la cuenta de muestra: ${createErr.message}`)
  const sampleUserId = created.user.id

  const { error: profileErr } = await dev
    .from('profiles')
    .update({ display_name: 'Backup Muestra', role_key: 'soporte', role: 'soporte' })
    .eq('id', sampleUserId)
  if (profileErr) {
    fail('preparación', `no se pudo actualizar el perfil de la muestra: ${profileErr.message}`)
  }

  const { data: contact, error: contactErr } = await dev
    .from('contacts')
    .select('id, whatsapp_number, name, country')
    .eq('whatsapp_number', '+525550000001')
    .maybeSingle<{ id: string; whatsapp_number: string; name: string | null; country: string | null }>()
  if (contactErr) {
    fail('preparación', `no se pudo leer el cliente sintético: ${contactErr.message}`)
  }
  if (!contact) fail('preparación', 'no hay cliente sintético: corre la semilla')

  const { data: chat, error: chatErr } = await dev
    .from('conversations')
    .insert({
      contact_id: contact.id,
      assigned_agent_id: sampleUserId,
      status: 'open',
      last_message_at: new Date().toISOString(),
      last_message_preview: SAMPLE_BODY,
      unread_count: 0,
    })
    .select('id')
    .single<{ id: string }>()
  if (chatErr) fail('preparación', `no se pudo crear el chat de muestra: ${chatErr.message}`)

  const { data: message, error: msgErr } = await dev
    .from('messages')
    .insert({ conversation_id: chat.id, direction: 'in', body: SAMPLE_BODY })
    .select('id')
    .single<{ id: string }>()
  if (msgErr) fail('preparación', `no se pudo crear el mensaje de muestra: ${msgErr.message}`)

  const { data: buckets, error: bucketsErr } = await dev.storage.listBuckets()
  if (bucketsErr) {
    fail('preparación', `no se pudieron listar los buckets: ${bucketsErr.message}`)
  }
  if (!buckets?.some((b) => b.name === 'whatsapp-media')) {
    fail('preparación', 'no existe el bucket whatsapp-media en el entorno de desarrollo')
  }
  const filePath = `muestra/${SAMPLE_FILE_NAME}`
  const { error: upErr } = await dev.storage
    .from('whatsapp-media')
    .upload(filePath, SAMPLE_FILE_CONTENT, { contentType: 'text/plain', upsert: true })
  if (upErr) fail('preparación', `no se pudo subir el archivo de muestra: ${upErr.message}`)

  console.log(`   cuenta=${SAMPLE_EMAIL} chat=${chat.id} mensaje=${message.id} archivo=${filePath}`)

  // ---------------------------------------------------------------- 2 · volcado
  console.log('== 2 · volcado del esquema public ==')
  const dumpPath = join(backupDir, 'public.sql')
  try {
    sh(
      'docker',
      [
        'exec',
        ORIGIN_DB_CONTAINER,
        'pg_dump',
        '-U',
        'postgres',
        '-d',
        'postgres',
        '--format=plain',
        '--schema=public',
        // El volcado es de ESQUEMA y DATOS. Los privilegios no viajan: los
        // fija el repo (las migraciones), que es su fuente de verdad, y los
        // `GRANT` del origen pertenecen a roles del cluster donde se crearon
        // (supabase_admin y compañía), fuera del alcance de un respaldo.
        '--no-privileges',
        '--file=/tmp/backup-public.sql',
      ],
      { quiet: true },
    )
    sh('docker', ['cp', `${ORIGIN_DB_CONTAINER}:/tmp/backup-public.sql`, dumpPath], { quiet: true })
    sh('docker', ['exec', ORIGIN_DB_CONTAINER, 'rm', '-f', '/tmp/backup-public.sql'], { quiet: true })
  } catch (e) {
    fail('volcado', `pg_dump falló: ${(e as Error).message}`)
  }
  if (!existsSync(dumpPath)) fail('volcado', `no se creó el volcado ${dumpPath}`)
  chmodSync(dumpPath, FILE_MODE)

  // ---------------------------------------------------------------- 3 · objetos de Storage
  console.log('== 3 · objetos del bucket whatsapp-media ==')
  // El esquema `storage` no está expuesto por PostgREST en la config local,
  // así que listamos los objetos directamente desde Postgres del contenedor.
  // El tipo de contenido se lee de `metadata.mimetype`: un archivo de
  // WhatsApp que no es texto tiene que volver con SU tipo, no con text/plain.
  let objectRows: Array<{ name: string; contentType: string | null }> = []
  try {
    const out = sh(
      'docker',
      [
        'exec',
        ORIGIN_DB_CONTAINER,
        'psql',
        '-U',
        'postgres',
        '-d',
        'postgres',
        '-tAc',
        "select name, coalesce(metadata->>'mimetype', '') from storage.objects where bucket_id = 'whatsapp-media'",
      ],
      { quiet: true },
    )
    objectRows = out
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [name, mimetype = ''] = line.split('|')
        return { name: name ?? '', contentType: mimetype || null }
      })
      .filter((obj) => obj.name.length > 0)
  } catch (e) {
    fail('storage', `no se pudo listar objetos: ${(e as Error).message}`)
  }
  for (const obj of objectRows) {
    const { data: downloaded, error: downErr } = await dev.storage
      .from('whatsapp-media')
      .download(obj.name)
    if (downErr || !downloaded) {
      fail('storage', `no se pudo descargar ${obj.name}: ${downErr?.message ?? 'sin datos'}`)
    }
    const bytes = Buffer.from(await downloaded.arrayBuffer())
    const dest = rutaDeObjeto(storageDir, obj.name)
    crearDirectorioCerrado(join(dest, '..'))
    escribirArchivoCerrado(dest, bytes)
    console.log(`   ${obj.name} (${bytes.length} bytes, ${obj.contentType ?? 'sin tipo'})`)
  }
  if (objectRows.length === 0) {
    console.log('   (bucket vacío)')
  }

  // ---------------------------------------------------------------- 4 · manifiesto
  console.log('== 4 · manifiesto ==')
  const ledger = await sql<{ filename: string; applied_at: string }>(
    DEV_DB,
    `select filename, applied_at from public.schema_migrations order by filename`,
  )

  // Extensiones que el esquema público necesita: `pg_dump --schema=public`
  // NO las incluye (son objetos de base, no de esquema), así que sin esta
  // lista el volcado no se puede aplicar en una base limpia.
  const extensionRows = await sql<{ extname: string }>(
    DEV_DB,
    `select extname from pg_extension where extname <> 'plpgsql' order by extname`,
  )
  const extensions = extensionRows.map((row) => row.extname)

  // Filas por tabla del esquema volcado: es lo que permite comprobar que el
  // dump contiene los datos y no solo el esquema.
  const tableRows = await sql<{ table_name: string }>(
    DEV_DB,
    `select table_name from information_schema.tables
      where table_schema = 'public' and table_type = 'BASE TABLE'
      order by table_name`,
  )
  const tableCounts: Array<{ table: string; rows: number }> = []
  for (const row of tableRows) {
    const identifier = `"${row.table_name.replace(/"/g, '""')}"`
    const counted = await sql<{ total: string }>(
      DEV_DB,
      `select count(*)::text as total from public.${identifier}`,
    )
    tableCounts.push({ table: row.table_name, rows: Number(counted[0]?.total ?? 0) })
  }

  // Claves foráneas del esquema `public` que apuntan FUERA de `public` (en
  // Supabase, `auth.users` lo administra GoTrue y no está en el respaldo).
  // Sin esta lista el volcado no se puede aplicar en una base limpia.
  const dependencyRows = await sql<{
    schema_name: string
    table_name: string
    ref_column: string
    ref_type: string
    from_schema: string
    from_table: string
    from_column: string
  }>(
    DEV_DB,
    `select n2.nspname as schema_name,
            c2.relname as table_name,
            a_ref.attname as ref_column,
            format_type(a_ref.atttypid, a_ref.atttypmod) as ref_type,
            n1.nspname as from_schema,
            c1.relname as from_table,
            a_from.attname as from_column
       from pg_constraint c
       join pg_class c1 on c1.oid = c.conrelid
       join pg_namespace n1 on n1.oid = c1.relnamespace
       join pg_class c2 on c2.oid = c.confrelid
       join pg_namespace n2 on n2.oid = c2.relnamespace
       join lateral unnest(c.conkey, c.confkey) with ordinality
            as k(con_attnum, ref_attnum, ord) on true
       join pg_attribute a_ref
            on a_ref.attrelid = c2.oid and a_ref.attnum = k.ref_attnum
       join pg_attribute a_from
            on a_from.attrelid = c1.oid and a_from.attnum = k.con_attnum
      where c.contype = 'f'
        and n1.nspname = 'public'
        and n2.nspname <> 'public'
      order by n2.nspname, c2.relname, k.ord`,
  )
  const externalDependencies = dependencyRows.map((row) => ({
    schema: row.schema_name,
    table: row.table_name,
    column: row.ref_column,
    type: row.ref_type,
    fromSchema: row.from_schema,
    fromTable: row.from_table,
    fromColumn: row.from_column,
  }))

  const files: Array<{ path: string; size: number; sha256: string; contentType?: string }> = []
  files.push({ path: 'public.sql', size: readFileSync(dumpPath).length, sha256: sha256File(dumpPath) })
  for (const obj of objectRows) {
    const dest = rutaDeObjeto(storageDir, obj.name)
    const bytes = readFileSync(dest)
    files.push({
      path: `storage/${obj.name}`,
      size: bytes.length,
      sha256: sha256Bytes(bytes),
      contentType: obj.contentType ?? undefined,
    })
  }

  const manifest = {
    instanceId: instanceId(),
    commit: gitCommit(),
    date: new Date().toISOString(),
    migrations: ledger.map((l) => ({ filename: l.filename, applied_at: l.applied_at })),
    account: { email: SAMPLE_EMAIL, password: samplePassword },
    contact: {
      id: contact.id,
      whatsapp_number: contact.whatsapp_number,
      name: contact.name,
      country: contact.country,
    },
    conversation: { id: chat.id, body: SAMPLE_BODY },
    message: { id: message.id },
    attachment: { path: filePath },
    extensions,
    tableCounts,
    externalDependencies,
    files,
  }

  const manifestPath = join(backupDir, 'manifest.json')
  escribirArchivoCerrado(manifestPath, JSON.stringify(manifest, null, 2))

  console.log(`   respaldo=${backupDir}`)
  console.log(`   manifiesto=${manifestPath}`)
  console.log(`   archivos=${files.length}`)
  console.log(`   tablas=${tableCounts.length} extensiones=${extensions.length}`)
  console.log(backupDir)
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})

/**
 * Crea un respaldo completo de la instancia de desarrollo en un directorio
 * del disco: esquema `public`, objetos del bucket `whatsapp-media` y un
 * manifiesto con hashes sha256.
 *
 * El respaldo es autocontenido: la restauración no necesita conectarse al
 * origen, solo leer los archivos de este directorio.
 *
 *   cd apps/api && pnpm exec tsx scripts/create-backup.ts
 */
import 'dotenv/config'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { Client } from 'pg'

const REPO = process.cwd().endsWith('apps/api') ? process.cwd() : join(process.cwd(), 'apps/api')
const REPO_ROOT = join(REPO, '..', '..')
const BACKUPS_DIR = process.env.BACKUPS_DIR ?? join(homedir(), 'supabase-dev/backups')
const ORIGIN_STACK_DIR = process.env.ORIGIN_STACK_DIR ?? join(homedir(), 'supabase-dev/onano-support-dev')
const ORIGIN_DB_CONTAINER = process.env.ORIGIN_DB_CONTAINER ?? 'supabase_db_onano-support-dev'

const DEV_API = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321'
const DEV_KEY = process.env.SUPABASE_SECRET_KEY ?? ''
const DEV_DB = process.env.DATABASE_URL ?? ''

const SAMPLE_EMAIL = 'backup.rehearsal@example.test'
const SAMPLE_PASSWORD = 'Backup-rehearsal-9931'
const SAMPLE_BODY = 'Mensaje de muestra para el ensayo de respaldo.'
const SAMPLE_FILE_NAME = 'backup-rehearsal.txt'
const SAMPLE_FILE_CONTENT = 'Contenido de muestra del ensayo de respaldo.\nsegunda línea\n'

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

async function sql<T = unknown>(connectionString: string, text: string): Promise<T[]> {
  const host = (() => {
    try {
      return new URL(connectionString).hostname
    } catch {
      return ''
    }
  })()
  const local = ['127.0.0.1', 'localhost', '::1'].includes(host)
  const pg = new Client({ connectionString, ssl: local ? false : { rejectUnauthorized: false } })
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

async function main() {
  if (!DEV_KEY || !DEV_DB) {
    fail('preparación', 'faltan SUPABASE_SECRET_KEY o DATABASE_URL del entorno de desarrollo')
  }

  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)
  const backupDir = join(BACKUPS_DIR, `backup-${stamp}`)
  const storageDir = join(backupDir, 'storage')
  mkdirSync(backupDir, { recursive: true })
  mkdirSync(storageDir, { recursive: true })

  const dev = createClient(DEV_API, DEV_KEY, { auth: { persistSession: false } })

  // ---------------------------------------------------------------- 1 · muestra
  console.log('== 1 · muestra sintética en el origen ==')
  const { data: listed } = await dev.auth.admin.listUsers({ page: 1, perPage: 200 })
  const existing = listed?.users.find((u) => u.email?.toLowerCase() === SAMPLE_EMAIL)
  if (existing) await dev.auth.admin.deleteUser(existing.id)
  const { data: created, error: createErr } = await dev.auth.admin.createUser({
    email: SAMPLE_EMAIL,
    password: SAMPLE_PASSWORD,
    email_confirm: true,
    user_metadata: { display_name: 'Backup Muestra' },
  })
  if (createErr) fail('preparación', `no se pudo crear la cuenta de muestra: ${createErr.message}`)
  const sampleUserId = created.user.id
  await dev
    .from('profiles')
    .update({ display_name: 'Backup Muestra', role_key: 'soporte', role: 'soporte' })
    .eq('id', sampleUserId)

  const { data: contact } = await dev
    .from('contacts')
    .select('id, whatsapp_number, name, country')
    .eq('whatsapp_number', '+525550000001')
    .maybeSingle<{ id: string; whatsapp_number: string; name: string | null; country: string | null }>()
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

  const { data: buckets } = await dev.storage.listBuckets()
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

  // ---------------------------------------------------------------- 3 · objetos de Storage
  console.log('== 3 · objetos del bucket whatsapp-media ==')
  // El esquema `storage` no está expuesto por PostgREST en la config local,
  // así que listamos los objetos directamente desde Postgres del contenedor.
  let objectRows: Array<{ name: string }> = []
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
        "select name from storage.objects where bucket_id = 'whatsapp-media'",
      ],
      { quiet: true },
    )
    objectRows = out
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((name) => ({ name }))
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
    const dest = join(storageDir, obj.name)
    mkdirSync(join(dest, '..'), { recursive: true })
    writeFileSync(dest, bytes)
    console.log(`   ${obj.name} (${bytes.length} bytes)`)
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

  const files: Array<{ path: string; size: number; sha256: string }> = []
  files.push({ path: 'public.sql', size: readFileSync(dumpPath).length, sha256: sha256File(dumpPath) })
  for (const obj of objectRows) {
    const dest = join(storageDir, obj.name)
    const bytes = readFileSync(dest)
    files.push({ path: `storage/${obj.name}`, size: bytes.length, sha256: sha256Bytes(bytes) })
  }

  const manifest = {
    instanceId: instanceId(),
    commit: gitCommit(),
    date: new Date().toISOString(),
    migrations: ledger.map((l) => ({ filename: l.filename, applied_at: l.applied_at })),
    account: { email: SAMPLE_EMAIL, password: SAMPLE_PASSWORD },
    contact: {
      id: contact.id,
      whatsapp_number: contact.whatsapp_number,
      name: contact.name,
      country: contact.country,
    },
    conversation: { id: chat.id, body: SAMPLE_BODY },
    message: { id: message.id },
    attachment: { path: filePath },
    files,
  }

  const manifestPath = join(backupDir, 'manifest.json')
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))

  console.log(`   respaldo=${backupDir}`)
  console.log(`   manifiesto=${manifestPath}`)
  console.log(`   archivos=${files.length}`)
  console.log(backupDir)
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})

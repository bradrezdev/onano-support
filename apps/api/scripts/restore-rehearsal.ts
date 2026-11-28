/**
 * Ensayo de restauración desde disco (PR #1).
 *
 * Recibe un directorio de respaldo (--backup <dir>) y restaura su contenido
 * en la instancia de restauración SIN conectarse al origen. El ensayo
 * demuestra que el respaldo es autocontenido: el origen puede estar apagado.
 *
 * Pasos:
 *   1 · Verifica la integridad del respaldo (archivos presentes y hashes).
 *   2 · Limpia y recrea el esquema `public` en la instancia de restauración.
 *   3 · Aplica las migraciones del repo en la instancia de restauración.
 *   4 · Crea la cuenta de la muestra en el destino con la contraseña del
 *       manifiesto (los hashes de contraseña no migran entre instancias).
 *   5 · Restaura las filas de la muestra desde el manifiesto.
 *   6 · Restaura los objetos del bucket `whatsapp-media` desde disco.
 *   7 · Verifica identidad, permisos, relación cuenta↔chat, historial y bytes
 *       del adjunto usando los route handlers reales en proceso.
 *   8 · Registra el resultado fuera de la base.
 *
 *   cd apps/api && pnpm exec tsx scripts/restore-rehearsal.ts --backup <dir>
 */
import 'dotenv/config'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, appendFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { Client } from 'pg'
import { createClient } from '@supabase/supabase-js'
import { verifyBackupIntegrity, type BackupManifest } from '../src/lib/backup-integrity'

const REPO = process.cwd().endsWith('apps/api') ? process.cwd() : join(process.cwd(), 'apps/api')
const REPO_ROOT = join(REPO, '..', '..')
const RESTORE_STACK_DIR =
  process.env.RESTORE_STACK_DIR ?? join(homedir(), 'supabase-dev/onano-support-restore')
const BACKUP_DIR = process.env.BACKUP_DIR ?? join(homedir(), 'supabase-dev/backups')
const REGISTRY = join(BACKUP_DIR, 'registry.jsonl')

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

function register(entry: Record<string, unknown>) {
  mkdirSync(BACKUP_DIR, { recursive: true })
  appendFileSync(REGISTRY, JSON.stringify(entry) + '\n')
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

async function sql<T = unknown>(connectionString: string, text: string): Promise<T[]> {
  const host = (() => {
    try {
      return new URL(connectionString).hostname
    } catch {
      return ''
    }
  })()
  const local = ['127.0.0.1', 'localhost', '::1'].includes(host)
  const pg = new Client({
    connectionString,
    ssl: local ? false : { rejectUnauthorized: false },
  })
  await pg.connect()
  try {
    const res = await pg.query(text)
    return res.rows as T[]
  } finally {
    await pg.end()
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
  if (idx === -1 || !args[idx + 1]) {
    console.error('Uso: pnpm exec tsx scripts/restore-rehearsal.ts --backup <directorio>')
    process.exit(2)
  }
  return { backupDir: args[idx + 1] }
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
  mkdirSync(BACKUP_DIR, { recursive: true })

  // ---------------------------------------------------------------- 1 · integridad
  console.log('== 1 · integridad del respaldo ==')
  const integrity = verifyBackupIntegrity(backupDir, manifest)
  if (!integrity.ok) fail('integridad', integrity.error)
  console.log('   archivos presentes y hashes correctos')

  // ---------------------------------------------------------------- 2 · instancia de restauración
  console.log('== 2 · instancia de restauración ==')
  const restoreEnv = prepareRestoreStack()
  console.log(`   API=${restoreEnv.apiUrl} DB=${restoreEnv.dbUrl}`)

  // ---------------------------------------------------------------- 3 · estado limpio
  console.log('== 3 · estado limpio del destino ==')
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

  // ---------------------------------------------------------------- 4 · migraciones
  console.log('== 4 · migraciones del repo en la instancia restaurada ==')
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

  // ---------------------------------------------------------------- 5 · restaurar muestra
  console.log('== 5 · restauración de la muestra ==')
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
  const workDir = mkdtempSync(join(tmpdir(), 'crm-restore-'))
  WORK_DIR = workDir
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

  const psql = existsSync('/opt/homebrew/opt/libpq/bin/psql')
    ? '/opt/homebrew/opt/libpq/bin/psql'
    : 'psql'
  if (!psql.includes('libpq')) {
    const url = new URL(restoreEnv.dbUrl)
    process.env.PGPASSWORD = decodeURIComponent(url.password ?? '')
  }
  const psqlArgs = psql.includes('libpq')
    ? [restoreEnv.dbUrl, '-v', 'ON_ERROR_STOP=1', '-f', sampleSqlPath]
    : [
        '-h',
        new URL(restoreEnv.dbUrl).hostname,
        '-U',
        'postgres',
        '-d',
        'postgres',
        '-v',
        'ON_ERROR_STOP=1',
        '-f',
        sampleSqlPath,
      ]
  try {
    sh(psql, psqlArgs, { quiet: true })
  } catch (e) {
    const out = `${(e as { stdout?: string }).stdout ?? ''}${(e as { stderr?: string }).stderr ?? ''}`
    fail('restauración', `la muestra no se restauró: ${out.slice(-800)}`)
  }

  // ---------------------------------------------------------------- 6 · objetos de Storage
  console.log('== 6 · objetos de Storage desde disco ==')
  const storageDir = join(backupDir, 'storage')
  if (existsSync(storageDir)) {
    const { readdirSync, statSync } = await import('node:fs')
    const walk = (dir: string): string[] => {
      const out: string[] = []
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry)
        if (statSync(full).isDirectory()) {
          out.push(...walk(full))
        } else {
          out.push(full)
        }
      }
      return out
    }
    const files = walk(storageDir)
    for (const fullPath of files) {
      const objectName = fullPath.slice(storageDir.length + 1)
      const bytes = readFileSync(fullPath)
      const { error: upErr } = await rest.storage
        .from('whatsapp-media')
        .upload(objectName, bytes, { contentType: 'text/plain', upsert: true })
      if (upErr) fail('storage', `no se pudo subir ${objectName}: ${upErr.message}`)
      console.log(`   ${objectName} (${bytes.length} bytes)`)
    }
    if (files.length === 0) console.log('   (sin objetos)')
  }

  // ---------------------------------------------------------------- 7 · verificación
  console.log('== 7 · verificación en la instancia restaurada ==')
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

  // 7.1 · identidad + permisos
  const me = await callRoute<undefined>(meRoute.GET, '/api/me', token, undefined)
  if (me.status !== 200) {
    fail('verificación', `/api/me respondió ${me.status} en la copia`)
  }
  const permissions = me.body?.data?.permissions ?? []
  if (!Array.isArray(permissions) || permissions.length === 0) {
    fail('verificación', 'la copia devolvió un keyring vacío: los permisos no se restauraron')
  }

  // 7.2 · relación cuenta↔chat y contacto
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
    fail('verificación', 'el chat no apunta al contacto restaurado')
  }

  // 7.3 · historial del chat, servido y autorizado por la app
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

  // 7.4 · bytes del adjunto de la muestra
  const sampleFileEntry = manifest.files.find((f) => f.path === `storage/${manifest.attachment.path}`)
  if (!sampleFileEntry) {
    fail('verificación', `el manifiesto no incluye el adjunto de la muestra: ${manifest.attachment.path}`)
  }
  const objectName = sampleFileEntry.path.slice('storage/'.length)
  const backupBytes = readFileSync(join(backupDir, sampleFileEntry.path))
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

  // ---------------------------------------------------------------- 8 · registro
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
      'inicio de sesión',
      'keyring de permisos',
      'relación cuenta-chat-contacto',
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

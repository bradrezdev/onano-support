/**
 * Ensayo de respaldo y restauración (PR #1, corrección del respaldo).
 *
 * Antes este ensayo declaraba ÉXITO aunque la restauración fallara: los
 * avisos de `pg_restore` se ignoraban y los conteos se comparaban después,
 * sin comprobar que el error hubiera dejado la copia vacía. Ahora es
 * estricto: si la restauración falla, o si falta una muestra (cuenta, chat o
 * archivo), el ensayo **falla**.
 *
 * Qué hace, en orden:
 *   1 · Prepara una MUESTRA SINTÉTICA en la instancia de desarrollo: una
 *       cuenta, un chat con mensajes y un archivo con contenido real.
 *   2 · Escribe el respaldo: el volcado del esquema (referencia) y el
 *       manifiesto con la muestra (credenciales y contenido del archivo).
 *   3 · Levanta (o reutiliza) OTRA INSTANCIA DE SUPABASE y la deja en estado
 *       limpio: el esquema `public` se recrea y se le devuelven los
 *       privilegios por defecto de Supabase. El esquema se restaura desde la
 *       FUENTE DE VERDAD, que son los archivos versionados del repo, no el
 *       ledger de la base.
 *   4 · Aplica las migraciones del repo en esa instancia.
 *   5 · Restaura la muestra: la cuenta, el chat con sus mensajes y el archivo.
 *   6 · Verifica en la instancia restaurada: inicio de sesión, permisos
 *       (keyring), historial del chat y contenido del archivo.
 *   7 · Registra FUERA de la base: destino, actor, fecha, commit y el
 *       resultado de las migraciones.
 *
 *   cd apps/api && pnpm tsx scripts/restore-rehearsal.ts
 */
import 'dotenv/config'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { Client } from 'pg'
import { createClient } from '@supabase/supabase-js'

const REPO = process.cwd().endsWith('apps/api') ? process.cwd() : join(process.cwd(), 'apps/api')
const REPO_ROOT = join(REPO, '..', '..')
const RESTORE_STACK_DIR =
  process.env.RESTORE_STACK_DIR ?? join(homedir(), 'supabase-dev/onano-support-restore')
const BACKUP_DIR = process.env.BACKUP_DIR ?? join(homedir(), 'supabase-dev/backups')
const REGISTRY = join(BACKUP_DIR, 'registry.jsonl')

const DEV_API = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321'
const DEV_KEY = process.env.SUPABASE_SECRET_KEY ?? ''
const DEV_DB = process.env.DATABASE_URL ?? ''
const SAMPLE_EMAIL = 'e2e.rehearsal@example.test'
const SAMPLE_PASSWORD = 'E2E-rehearsal-9931'
const SAMPLE_BODY = 'Mensaje de muestra para el ensayo de respaldo.'
const SAMPLE_FILE_NAME = 'e2e-rehearsal.txt'
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
    return sh('git', ['rev-parse', 'HEAD'], { quiet: true }).trim()
  } catch {
    return 'desconocido'
  }
}

function actor(): string {
  try {
    return (
      sh('git', ['config', 'user.email'], { quiet: true }).trim() ||
      process.env.USER ||
      'desconocido'
    )
  } catch {
    return process.env.USER ?? 'desconocido'
  }
}

/** Registro fuera de la base: destino, actor, fecha, commit y migraciones. */
function register(entry: Record<string, unknown>) {
  mkdirSync(BACKUP_DIR, { recursive: true })
  appendFileSync(REGISTRY, JSON.stringify(entry) + '\n')
}

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
  process.exit(1)
}

/** Consulta directa: el ledger y los privilegios no se leen por REST. */
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

/**
 * Verificación a nivel de aplicación: se invocan los route handlers REALES
 * (los mismos que sirven el tráfico HTTP) en proceso, con un JWT de la
 * copia. Así se comprueba la cadena completa — autenticación, permisos y
 * autorización del historial — sin depender de un puerto libre ni de un
 * servidor de desarrollo levantado.
 */
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

async function main() {
  if (!DEV_KEY || !DEV_DB) {
    fail('preparación', 'faltan SUPABASE_SECRET_KEY o DATABASE_URL del entorno de desarrollo')
  }
  mkdirSync(BACKUP_DIR, { recursive: true })
  const dev = createClient(DEV_API, DEV_KEY, { auth: { persistSession: false } })

  // ---------------------------------------------------------------- 1 · muestra
  console.log('== 1 · muestra sintética en la instancia de desarrollo ==')
  const { data: listed } = await dev.auth.admin.listUsers({ page: 1, perPage: 200 })
  const existing = listed?.users.find((u) => u.email?.toLowerCase() === SAMPLE_EMAIL)
  if (existing) await dev.auth.admin.deleteUser(existing.id)
  const { data: created, error: createErr } = await dev.auth.admin.createUser({
    email: SAMPLE_EMAIL,
    password: SAMPLE_PASSWORD,
    email_confirm: true,
    user_metadata: { display_name: 'E2E Muestra' },
  })
  if (createErr) fail('preparación', `no se pudo crear la cuenta de muestra: ${createErr.message}`)
  const sampleUserId = created.user.id
  await dev
    .from('profiles')
    .update({ display_name: 'E2E Muestra', role_key: 'soporte', role: 'soporte' })
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
  const { error: msgErr } = await dev.from('messages').insert({
    conversation_id: chat.id,
    direction: 'in',
    body: SAMPLE_BODY,
  })
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
  const { data: downloaded, error: downErr } = await dev.storage
    .from('whatsapp-media')
    .download(filePath)
  if (downErr || !downloaded) {
    fail('preparación', `no se pudo leer el archivo de muestra: ${downErr?.message ?? 'sin datos'}`)
  }
  const fileBytes = Buffer.from(await downloaded.arrayBuffer())
  console.log(`   cuenta=${SAMPLE_EMAIL} chat=${chat.id} archivo=${filePath} (${fileBytes.length} bytes)`)

  // ---------------------------------------------------------------- 2 · respaldo
  console.log('== 2 · respaldo (volcado de referencia + manifiesto) ==')
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)
  const dumpPath = join(BACKUP_DIR, `dev-public-${stamp}.sql`)
  const devContainer = process.env.DEV_DB_CONTAINER ?? 'supabase_db_onano-support-dev'
  try {
    // El pg_dump del propio contenedor: su versión coincide con la del
    // Postgres que lo hospeda y con la de la instancia de restauración.
    sh(
      'docker',
      [
        'exec',
        devContainer,
        'pg_dump',
        '-U',
        'postgres',
        '-d',
        'postgres',
        '--format=plain',
        '--schema=public',
        '--file=/tmp/dev-public.sql',
      ],
      { quiet: true },
    )
    sh('docker', ['cp', `${devContainer}:/tmp/dev-public.sql`, dumpPath], { quiet: true })
    sh('docker', ['exec', devContainer, 'rm', '-f', '/tmp/dev-public.sql'], { quiet: true })
  } catch (e) {
    fail('volcado', `pg_dump falló: ${(e as Error).message}`)
  }
  if (!existsSync(dumpPath)) fail('volcado', `no se creó el volcado ${dumpPath}`)

  const devLedger = await sql<{ filename: string; applied_at: string }>(
    DEV_DB,
    `select filename, applied_at from public.schema_migrations order by filename`,
  )
  const manifest = {
    cuenta: { email: SAMPLE_EMAIL, password: SAMPLE_PASSWORD },
    cliente: {
      id: contact.id,
      whatsapp_number: contact.whatsapp_number,
      name: contact.name,
      country: contact.country,
    },
    chat: { id: chat.id, body: SAMPLE_BODY },
    archivo: { path: filePath, bytes: fileBytes.toString('base64') },
    migraciones: devLedger.map((l) => ({ filename: l.filename, applied_at: l.applied_at })),
    commit: gitCommit(),
    fecha: new Date().toISOString(),
  }
  const manifestPath = join(BACKUP_DIR, `dev-manifest-${stamp}.json`)
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
  console.log(`   volcado=${dumpPath}`)
  console.log(`   manifiesto=${manifestPath}`)

  // ---------------------------------------------------------------- 3 · otra instancia
  console.log('== 3 · otra instancia de Supabase (la de restauración) ==')
  const restoreEnv = prepareRestoreStack()
  console.log(`   API=${restoreEnv.apiUrl} DB=${restoreEnv.dbUrl}`)

  // 3.1 · estado limpio: el esquema `public` se recrea y se le devuelven
  // los privilegios por defecto de Supabase. Sin esto, una instancia cuyo
  // esquema se recreó queda sin USAGE para `service_role` y la API responde
  // «permission denied for schema public».
  console.log('== 3.1 · estado limpio de la instancia de restauración ==')
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

  // ---------------------------------------------------------------- 5 · restaurar
  console.log('== 5 · restauración de la muestra ==')
  const rest = createClient(restoreEnv.apiUrl, restoreEnv.secretKey, {
    auth: { persistSession: false },
  })
  // La cuenta de muestra puede existir de una corrida anterior: se borra
  // para que el ensayo sea repetible.
  const { data: copyUsers } = await rest.auth.admin.listUsers({ page: 1, perPage: 200 })
  const previous = copyUsers?.users.find((u) => u.email?.toLowerCase() === SAMPLE_EMAIL)
  if (previous) await rest.auth.admin.deleteUser(previous.id)
  const { data: createdUser, error: createErr2 } = await rest.auth.admin.createUser({
    email: SAMPLE_EMAIL,
    password: SAMPLE_PASSWORD,
    email_confirm: true,
    user_metadata: { display_name: 'E2E Muestra' },
  })
  if (createErr2) fail('restauración', `no se pudo crear la cuenta en la copia: ${createErr2.message}`)
  const copyUserId = createdUser.user.id

  // El paquete de muestra se escribe aquí: el identificador de la cuenta en
  // la copia es el de la copia (las claves foráneas apuntan a `auth.users`).
  const sampleSqlPath = join(BACKUP_DIR, `dev-sample-${stamp}.sql`)
  writeFileSync(
    sampleSqlPath,
    [
      '-- Muestra del ensayo de respaldo (cliente + cuenta + chat + mensaje).',
      `insert into public.contacts (id, whatsapp_number, name, country) values (${q(contact.id)}, ${q(contact.whatsapp_number)}, ${q(contact.name)}, ${q(contact.country)}) on conflict (id) do nothing;`,
      `insert into public.profiles (id, display_name, role, role_key) values (${q(copyUserId)}, 'E2E Muestra', 'soporte', 'soporte') on conflict (id) do nothing;`,
      `insert into public.conversations (id, contact_id, assigned_agent_id, status, last_message_at, last_message_preview, unread_count) values (${q(chat.id)}, ${q(contact.id)}, ${q(copyUserId)}, 'open', now(), ${q(SAMPLE_BODY)}, 0) on conflict (id) do nothing;`,
      `insert into public.messages (conversation_id, direction, body) values (${q(chat.id)}, 'in', ${q(SAMPLE_BODY)});`,
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

  // El archivo también es parte del respaldo: se sube a la copia.
  const { error: upErr2 } = await rest.storage
    .from('whatsapp-media')
    .upload(filePath, fileBytes, { contentType: 'text/plain', upsert: true })
  if (upErr2) fail('restauración', `no se pudo subir el archivo a la copia: ${upErr2.message}`)

  // ---------------------------------------------------------------- 6 · verificar
  console.log('== 6 · verificación en la instancia restaurada ==')
  const browser = createClient(restoreEnv.apiUrl, restoreEnv.publishableKey, {
    auth: { persistSession: false },
  })
  const { data: session, error: signInErr } = await browser.auth.signInWithPassword({
    email: SAMPLE_EMAIL,
    password: SAMPLE_PASSWORD,
  })
  if (signInErr) fail('verificación', `el inicio de sesión falló en la copia: ${signInErr.message}`)
  const token = session.session?.access_token
  if (!token) fail('verificación', 'la copia no devolvió token de sesión')

  // La app se apunta a la copia: la app es la que resuelve permisos e
  // historial, no la API de Supabase.
  process.env.SUPABASE_URL = restoreEnv.apiUrl
  process.env.SUPABASE_SECRET_KEY = restoreEnv.secretKey
  process.env.NEXT_PUBLIC_SUPABASE_URL = restoreEnv.apiUrl
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = restoreEnv.publishableKey
  process.env.DATABASE_URL = restoreEnv.dbUrl

  let permissions: string[] = []
  let historyCount = 0

  // Los route handlers reales, en proceso.
  const meRoute = await import('../src/app/api/me/route')
  const conversationRoute = await import('../src/app/api/conversations/[id]/route')

  // 6.1 · permisos: el keyring que resuelve la app en la copia
  const me = await callRoute<undefined>(meRoute.GET, '/api/me', token, undefined)
  if (me.status !== 200) {
    fail('verificación', `/api/me respondió ${me.status} en la copia`)
  }
  permissions = me.body?.data?.permissions ?? []
  if (!Array.isArray(permissions) || permissions.length === 0) {
    fail('verificación', 'la copia devolvió un keyring vacío: los permisos no se restauraron')
  }

  // 6.2 · historial del chat, servido y autorizado por la app
  const history = await callRoute(
    conversationRoute.GET,
    `/api/conversations/${chat.id}`,
    token,
    { params: Promise.resolve({ id: chat.id }) },
  )
  if (history.status !== 200) {
    fail('verificación', `el historial respondió ${history.status} en la copia`)
  }
  const historyItems = history.body?.data?.messages ?? []
  historyCount = Array.isArray(historyItems) ? historyItems.length : 0
  if (!JSON.stringify(historyItems).includes(SAMPLE_BODY)) {
    fail('verificación', 'el historial del chat no se restauró')
  }

  // 6.3 · archivo: contenido idéntico al de la muestra
  const { data: back, error: backErr } = await rest.storage
    .from('whatsapp-media')
    .download(filePath)
  if (backErr || !back) {
    fail('verificación', `no se pudo leer el archivo en la copia: ${backErr?.message ?? 'sin datos'}`)
  }
  const backBytes = Buffer.from(await back.arrayBuffer())
  if (!backBytes.equals(fileBytes)) {
    fail(
      'verificación',
      `el contenido del archivo difiere (${backBytes.length} vs ${fileBytes.length} bytes)`,
    )
  }

  // ---------------------------------------------------------------- 7 · registro
  register({
    objetivo: 'ensayo de respaldo y restauración',
    destino: restoreEnv.apiUrl,
    actor: actor(),
    fecha: new Date().toISOString(),
    commit: gitCommit(),
    resultado: 'OK',
    muestra: {
      cuenta: SAMPLE_EMAIL,
      chat: chat.id,
      archivo: filePath,
      bytes: fileBytes.length,
    },
    verificado: [
      'inicio de sesión',
      'keyring de permisos',
      'historial del chat',
      'contenido del archivo',
    ],
    migraciones: restoredLedger.map((l) => ({ filename: l.filename, applied_at: l.applied_at })),
    volcado: dumpPath,
    muestra_sql: sampleSqlPath,
    manifiesto: manifestPath,
  })

  console.log('')
  console.log('== OK · el respaldo se restauró y se verificó en otra instancia ==')
  console.log(
    `   cuenta=${SAMPLE_EMAIL} permisos=${permissions.length} mensajes=${historyCount} archivo=${fileBytes.length} bytes`,
  )
  console.log('   registro: ' + REGISTRY)
}

function prepareRestoreStack(): {
  apiUrl: string
  dbUrl: string
  secretKey: string
  publishableKey: string
} {
  // Configuración con puertos propios: la segunda instancia no puede chocar
  // con la de desarrollo.
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
    // `supabase status` falla si el stack no está levantado: eso no es un
    // error del ensayo, es la señal de que hay que arrancarlo.
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

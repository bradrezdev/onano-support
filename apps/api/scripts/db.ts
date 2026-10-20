/**
 * apps/api/scripts/db.ts — direct Postgres admin tool.
 *
 * Connects to your Supabase Postgres via DATABASE_URL (set in apps/api/.env).
 * Used by Claude (and you) to:
 *   - apply SQL migrations
 *   - execute raw SQL
 *   - inspect tables (read)
 *
 * SECURITY: this script connects with full Postgres superuser rights
 * (bypasses RLS). Never expose its command surface to untrusted input.
 *
 * Usage:
 *   pnpm --filter @crm/api db:migrate               # apply all *.sql in supabase/migrations/
 *   pnpm --filter @crm/api db:exec "<SQL>"         # run a single SQL statement
 *   pnpm --filter @crm/api db:exec ./script.sql     # run a SQL file
 *   pnpm --filter @crm/api db:query <table>         # select * from public.<table> limit 50
 *   pnpm --filter @crm/api db:tables               # list tables in public schema
 */
// @ts-nocheck — strict mode and argv narrowing fight each other; the script is short and trusted.

import 'dotenv/config'
import { Client } from 'pg'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve, isAbsolute } from 'node:path'

const argv = process.argv
const cmd = argv[2]
const arg0 = argv[3]

function requireEnv(name: string): string {
  const v = process.env[name]
  if (!v) {
    console.error(`Missing env: ${name}. Set it in apps/api/.env`)
    process.exit(2)
  }
  return v
}

async function withClient<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const url = requireEnv('DATABASE_URL')
  const c = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } })
  await c.connect()
  try {
    return await fn(c)
  } finally {
    await c.end()
  }
}

function repoRoot(): string {
  // apps/api/scripts/db.ts → repo root is ../../
  return resolve(process.cwd(), '..', '..')
}

function migrationsDir(): string {
  return join(repoRoot(), 'supabase', 'migrations')
}

async function cmdMigrate(): Promise<void> {
  const dir = migrationsDir()
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
  if (files.length === 0) {
    console.log(`No .sql files in ${dir}`)
    return
  }
  console.log(`Applying ${files.length} migrations from ${dir}\n`)
  await withClient(async (c) => {
    // Track applied migrations in a small table so re-runs are safe and
    // idempotent regardless of which IF NOT EXISTS guards each file ships.
    await c.query(`
      create table if not exists public.schema_migrations (
        filename text primary key,
        applied_at timestamptz not null default now()
      )
    `)

    const { rows: applied } = await c.query<{ filename: string }>(
      `select filename from public.schema_migrations`,
    )
    const appliedSet = new Set(applied.map((r) => r.filename))

    for (const f of files) {
      if (appliedSet.has(f)) {
        console.log(`> ${f} ... skip (recorded in schema_migrations)`)
        continue
      }
      const sql = readFileSync(join(dir, f), 'utf8')
      process.stdout.write(`> ${f} ... `)
      try {
        await c.query('begin')
        await c.query(sql)
        await c.query(
          `insert into public.schema_migrations (filename) values ($1) on conflict do nothing`,
          [f],
        )
        await c.query('commit')
        console.log('ok')
      } catch (err) {
        await c.query('rollback').catch(() => undefined)
        const msg = (err as Error).message
        // Tolerate idempotent re-runs even without schema_migrations seed:
        // skip if it's an "already exists" error and still record it.
        if (/already exists|duplicate/i.test(msg)) {
          await c
            .query(
              `insert into public.schema_migrations (filename) values ($1) on conflict do nothing`,
              [f],
            )
            .catch(() => undefined)
          console.log('skip (already applied)')
          continue
        }
        console.log('FAIL')
        console.error(`  ${msg}`)
        process.exitCode = 1
        return
      }
    }
  })
  console.log('\nDone.')
}

async function cmdExec(): Promise<void> {
  const argv = process.argv
  const input = argv[3]
  if (input === undefined || input.length === 0) {
    console.error('Usage: db:exec "<SQL>"  OR  db:exec ./path/to/file.sql')
    process.exit(2)
  }
  const arg: string = input as string
  let sql: string = arg
  if (arg.endsWith('.sql') && statSafe(arg).isFile()) {
    sql = readFileSync(arg, 'utf8')
  }
  await withClient(async (c) => {
    const res = await c.query(sql)
    const rows = res.rows ?? []
    if (rows.length > 0) {
      console.log(JSON.stringify(rows, null, 2))
      console.log(`\n(${rows.length} rows)`)
    } else {
      console.log(`OK (${res.rowCount ?? 0} rows affected)`)
    }
  })
}

function statSafe(p: string) {
  try {
    return statSync(p)
  } catch {
    return { isFile: () => false } as ReturnType<typeof statSync>
  }
}

async function cmdQuery(): Promise<void> {
  const argv = process.argv
  const table = argv[3]
  if (table === undefined || !/^[\w.]+$/.test(table)) {
    console.error('Usage: db:query <table>  (e.g. db:query profiles)')
    process.exit(2)
  }
  const fullName = table.includes('.') ? table : `public.${table}`
  await withClient(async (c) => {
    const res = await c.query(`select * from ${fullName} limit 50`)
    const rows = res.rows as Record<string, unknown>[]
    if (rows.length === 0) {
      console.log(`(empty)`)
      return
    }
    console.table(rows)
  })
}

async function cmdTables(): Promise<void> {
  await withClient(async (c) => {
    const res = await c.query<{ table_name: string }>(
      `select table_name from information_schema.tables
        where table_schema = 'public' order by table_name`,
    )
    console.log(res.rows.map((r) => r.table_name).join('\n'))
  })
}

async function main(): Promise<void> {
  switch (cmd) {
    case 'migrate':
      await cmdMigrate()
      break
    case 'exec':
      await cmdExec()
      break
    case 'query':
      await cmdQuery()
      break
    case 'tables':
      await cmdTables()
      break
    default:
      console.error(
        'Usage:\n' +
          '  db:migrate               apply all .sql in supabase/migrations/\n' +
          '  db:exec "<SQL>"          run one SQL statement\n' +
          '  db:exec ./file.sql       run a SQL file\n' +
          '  db:query <table>         select * from public.<table> limit 50\n' +
          '  db:tables                list tables in public schema',
      )
      process.exit(2)
  }
}

main().catch((err) => {
  console.error((err as Error).message)
  process.exit(1)
})
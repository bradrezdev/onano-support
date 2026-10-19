# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# whatsapp-CRM — multi-user WhatsApp CRM

Monorepo with two apps under `apps/*` (pnpm workspaces), one Supabase Postgres schema, and a direct-DB admin script that bypasses RLS.

## Stack (what's actually in the tree, not the README)

The root `README.md` is **stale** — it describes "Fastify backend + Vue 3 frontend". The actual code is:

- **`apps/api/`** — **Next.js 16.4.2** (App Router, port 3000) with TypeScript strict mode, Zod validation, Supabase server + admin clients. Replaces the planned Fastify service.
- **`apps/web/`** — **React 19 + Vite + TypeScript** (port 5173), Tailwind v3, Zustand, React Router v6 (`v7_relativeSplatPath` future flag enabled). Replaces the planned Vue 3 SPA.
- **`supabase/migrations/`** — SQL migrations (consolidated initial + RLS fix + service_role grant).
- **`apps/api/scripts/db.ts`** — direct Postgres admin tool using `DATABASE_URL` (superuser, **bypasses RLS**). Used for migrations, raw exec, table dumps.

Twilio integration is referenced in the README but the current API routes only cover `categories`, `contacts`, `flows`, `health`, `role-colors`, `themes`, `tickets`, `users` — outbound WhatsApp messaging and webhook handlers are still pending.

## Commands

Run from repo root unless noted.

```bash
pnpm install
pnpm dev            # parallel api (:3000) + web (:5173)
pnpm dev:api        # only api
pnpm dev:web        # only web
pnpm build          # tsc -b + next build + vite build
pnpm typecheck      # tsc -b --noEmit across the workspace
pnpm clean          # rm -rf dist .turbo node_modules .vite in every workspace
```

DB admin (all run via `apps/api/scripts/db.ts`, requires `DATABASE_URL` in `apps/api/.env`):

```bash
pnpm --filter @crm/api db:migrate              # apply every supabase/migrations/*.sql in order
pnpm --filter @crm/api db:exec "<SQL>"        # one SQL statement OR ./path/to.sql
pnpm --filter @crm/api db:query <table>       # select * from public.<table> limit 50
pnpm --filter @crm/api db:tables              # list tables in public schema
```

The script is idempotent on "already exists" errors; other failures stop the loop with `process.exitCode = 1`.

## Repository layout

```
apps/
  api/                  # Next.js backend — App Router under src/app
    src/app/            # /api/* route handlers (categories, contacts, flows, health,
                        #   role-colors, themes, tickets, users)
    src/lib/            # auth.ts (Bearer + cookie), supabase/{server,admin}.ts,
                        #   phone.ts, sanitize.ts, validate.ts
    src/services/       # data access / business logic (categories, themes,
                        #   tickets, ticket-messages, users)
    scripts/db.ts       # direct-DB admin tool (superuser, bypasses RLS)
  web/                  # React 19 SPA
    src/pages/          # route components (Login, Dashboard, Contacts, Categories,
                        #   Tickets/TicketNew/TicketDetail, Themes, FlowEditor,
                        #   Pipeline, Users, UserDetail, NotFound)
    src/components/     # layout/ (AppShell, Sidebar, Topbar, ProtectedRoute, RoleGuard)
                        #   ui/ (RichTextEditor)
    src/lib/            # api.ts (typed fetch + Bearer injection), supabase.ts,
                        #   permissions.ts (Role type), themes.ts, users.ts
    src/stores/auth.ts  # Zustand auth state
    src/router.tsx      # createBrowserRouter with future v7_relativeSplatPath
supabase/migrations/    # SQL migrations (consolidated initial, RLS fix, service_role grant)
odd/tasks/              # working notes (whatsapp-crm.md)
```

## Authentication flow

Both apps talk to the same Supabase project. The web SPA signs in via `@supabase/supabase-js` (anon key), stores the session, and forwards `Authorization: Bearer <jwt>` on every `apiFetch` request. The Next.js backend accepts either:

1. `Authorization: Bearer <jwt>` (frontend API client — primary path).
2. Supabase session cookie (server-rendered pages).

See `apps/api/src/lib/auth.ts` (`getCurrentUser`, `requireUser`, `requireRole`). Roles are `admin | supervisor | soporte`. Suspended or deleted profiles are rejected at auth time.

The web router uses `ProtectedRoute` (requires session) wrapping `AppShell`, and a nested `RoleGuard allow={['admin']}` for `/categories`, `/themes`, `/themes/:id`.

## Key conventions

- **Schema is in SQL, not Prisma/Drizzle.** All schema lives in `supabase/migrations/*.sql`. When adding a table/column/RLS policy, write a new migration file (`<timestamp>_<name>.sql`) and run `db:migrate`.
- **API routes call `services/`, never touch Supabase directly.** Route handlers in `src/app/api/*` delegate to `src/services/*` for queries and business logic.
- **Typed `apiFetch` everywhere on the web.** Use `api.get/post/patch/del` from `apps/web/src/lib/api.ts` — it auto-injects the Bearer token and throws `ApiError(status, code, message)` on non-2xx.
- **All env vars come from `apps/api/.env` and `apps/web/.env`.** Never commit them. See `.env.example` at repo root for the schema.
- **Roles are text-typed, not a Postgres enum** (`check (role in ('admin', 'supervisor', 'soporte'))`). Change the check constraint in a migration if adding a role.
- **Tailwind palette: `brand` + `role.{admin,supervisor,soporte}`** (see `apps/web/tailwind.config.js`). Role colors also expose CSS custom properties (`--role-admin` etc.) so backend can render them in tickets.

## Critical caveats

- **`apps/api/scripts/db.ts` connects with `DATABASE_URL` (Postgres superuser).** It bypasses RLS entirely. Never point it at a shared/prod DB, and never expose its argv to untrusted input. The web SPA does **not** touch this — it uses Supabase JS clients only.
- **`apps/api/AGENTS.md` block is re-injected by `next dev`.** Don't manually delete it; the generator at `node_modules/next/dist/server/lib/generate-agent-files.js` recreates it. This Next.js 16 has breaking changes — read `node_modules/next/dist/docs/` before writing API code.
- **README claims Twilio integration that doesn't yet exist in routes.** No outbound message sending or webhook handler is wired. Don't assume `apps/api/src/services/` knows about Twilio — it currently doesn't.
- **Service-role key lives in `apps/api/.env`.** The admin Supabase client (`apps/api/src/lib/supabase/admin.ts`) uses it for trusted server-side queries that need to bypass RLS (e.g. resolving the current user). Treat it like a DB superuser.
- **`tsconfig.base.json` enables `strict` + `noUncheckedIndexedAccess` + `noImplicitOverride`.** Array/object index access returns `T | undefined`. Don't silence these without a comment.
- **`pnpm` v11 with workspaces.** Don't introduce `package-lock.json` or `yarn.lock`. The pnpm-only enforcement hook runs at session start.
# AGENTS.md — whatsapp-CRM

Internal multi-user WhatsApp CRM for ONANO Global (tickets/incidents + team inbox). pnpm-workspaces monorepo over one Supabase project.

**Sources of truth:** `PRODUCT_SPEC.md` = scope (read before a task; update requirement status after). `CLAUDE.md` / `README.md` = deep architecture docs. `odd/tasks/whatsapp-crm.md` = living ODD feature doc (specs S#, tasks T#, log L#).

**Known doc drift (verified 2026-10):** the root `.env.example` is Fastify-era (it still lists `PORT=4000`, `SUPABASE_ANON_KEY`, `TWILIO_WHATSAPP_NUMBER`) — ignore it; the real layout is the Environment section below.

## Layout

- `apps/api` (`@crm/api`) — Next.js 16.4.6 App Router, :3000. Owns **all** data access via the service-role Supabase client (bypasses RLS). Route handlers in `src/app/api/**`, business logic + SQL in `src/services/**`.
- `apps/web` (`@crm/web`) — React 19 + Vite SPA, :5173. Supabase JS is used for the **auth session only**; all data goes through the API (`src/lib/api.ts` injects the Bearer token, throws `ApiError(status, code)`).
- `supabase/migrations/` — schema is raw SQL (no ORM). `db:migrate` tracks applied files in `public.schema_migrations`.
- `apps/api/scripts/` — `db.ts` (admin SQL) + smoke scripts; all load `apps/api/.env` via dotenv.

## Commands

```bash
pnpm install                     # pnpm v11 only — never add package-lock.json / yarn.lock
pnpm dev                         # api :3000 + web :5173 in parallel (dev:api / dev:web alone)
pnpm build                       # next build + (tsc -b && vite build)
pnpm typecheck && pnpm test      # api: `next typegen` + tsc --noEmit | web: tsc -b --noEmit
pnpm lint                        # oxlint — web only
pnpm e2e                         # Playwright

pnpm --filter @crm/api test src/services/users.test.ts   # single file (tests are colocated: *.test.ts)
pnpm --filter @crm/api test -t "createUser"              # single case by name
pnpm --filter @crm/web test:e2e                          # Playwright
```

- **Reproducible verification = what CI runs:** `CI=true pnpm install --frozen-lockfile` → `pnpm --filter @crm/api typegen` → `pnpm typecheck` → `pnpm test` → `pnpm lint` → `pnpm build`. The E2E job is separate: it boots an **ephemeral Supabase instance** (Docker on the runner), migrates with the repo runner, seeds **synthetic** data and runs the authenticated tests for real.
- **CI gates (E1)**: the target must be local (`scripts/../apps/api/scripts/assert-isolated-target.ts` refuses any non-local host); the API must **read** a test datum within the deadline or the job fails; **zero authenticated tests ⇒ the job fails** (E1 is PENDING, not green). `workflow_dispatch` accepts `controlled_failure` (`unit|lint|build|e2e`) to prove a gate turns red.
- **Migration runner is honest**: a migration that rolls back (duplicate object) stays **PENDING**, is NOT recorded in `schema_migrations`, and the command exits non-zero with the error. "already exists" does not mean it was applied.
- **`typegen` is not optional**: `apps/api` uses the `LayoutProps` global that Next generates, so `tsc` without `next typegen` fails on a clean checkout with `TS2304: Cannot find name 'LayoutProps'`. `pnpm --filter @crm/api typecheck` already chains it.
- **Node 22+** (`.nvmrc`, `engines.node >=22`). pnpm comes from `packageManager` (`pnpm@11.22.0`) only — pinning `version:` in `pnpm/action-setup` as well makes the action abort with "Multiple versions of pnpm specified".
- **Playwright** auto-starts only the *web* dev server; `apps/api` must already run on :3000 (`BASE_URL=...` skips the webServer). Protected tests **silently skip** without `E2E_EMAIL`/`E2E_PASSWORD` — "all green" can mean zero tests executed.
- **oxlint exits 0 today**: 24 pre-existing warnings (`set-state-in-effect`, `exhaustive-deps`, `purity`, `no-unused-vars`), **0 errors**. oxlint fails on errors, not on warnings — the exit code 1 the repo used to show came from one error (`react-hooks/rules-of-hooks` on the Playwright fixture), which is gone: the fixture callback in `apps/web/e2e/helpers/auth.ts` must NOT be named `use` or anything starting with `use`, or the linter reads it as a React hook. The warnings are not your regression unless the diff vs `main` says so.
- **DB tools** — superuser via `DATABASE_URL`, bypasses RLS; never point at a shared/prod DB:
  ```bash
  pnpm --filter @crm/api db:migrate            # apply supabase/migrations/*.sql in order, idempotent
  pnpm --filter @crm/api db:exec "<SQL>"       # or db:exec ./file.sql
  pnpm --filter @crm/api db:query <table>      # select * limit 50
  pnpm --filter @crm/api db:tables
  ```
  The runner stops at the **first** failed migration: the file stays PENDING (not recorded) and the migrations after it are not applied.
- **Antes de habilitar datos reales** — el veredicto lo da el validador, no la intuición:
  ```bash
  pnpm --filter @crm/api exec tsx scripts/validate-access-controls.ts          # informe
  pnpm --filter @crm/api exec tsx scripts/validate-access-controls.ts --strict # sale con 1 si algo queda PENDIENTE
  ```
  Six controls (simultaneous take of the same chat, an unrelated agent's access to history/messages/attachments, and whether a transfer changes the holder and is recorded with who and why) and a final verdict. **While the verdict says the environment cannot take real data, it stays synthetic.** Last run: **6 OK, 0 pending**.
- **Autorización de conversaciones y adjuntos (PR #2)** — la escritura y la transferencia van por funciones `security definer` del repo, no por el cliente de la app:
  - `append_outbound_message` valida el titular **y** guarda el mensaje en la misma transacción. Un agente que no es el titular recibe **409 `assignment_changed`** y **no se guarda nada** (ni se encola: no hay cola de salida).
  - `reassign_conversation` exige **motivo** y **versión vigente**: `PATCH /api/conversations/:id` con `{ assigned_agent_id, reason, expected_version }`. Con una versión obsoleta responde **409 `version_conflict`**; el cambio y su bitácora (`conversation_audit_log`, append-only) se escriben en la **misma** transacción, así que dos peticiones con la misma versión producen **un** cambio y **un** evento.
  - `take_conversation` también bumpea la versión y deja bitácora (motivo `take`).
  - Los adjuntos se autorizan por pertenencia: titular del ticket, titular de un chat del mensaje, o `admin`/`supervisor`. El **archivo** solo se sirve por **URL firmada** que emite la API tras autorizar; el bucket es privado y **las políticas de Storage para `authenticated` se eliminaron** (antes cualquier autenticado podía leer y borrar adjuntos).
- **Respaldo y restauración** — `bash scripts/dev/backup-and-verify-restore.sh` crea un respaldo autocontenido (esquema `public`, objetos de `whatsapp-media` y manifiesto con sha256), detiene el origen, restaura desde disco en otra instancia y verifica identidad, permisos, relación cuenta-chat, historial y bytes del adjunto. Ver `docs/respaldos.md`. (docs: contrato de autorización, permisos efectivos del proyecto anterior y credenciales)
- **Smoke tests against the real DB** (from `apps/api`): `pnpm tsx scripts/smoke-batch.ts` (services; restores what it modifies), `pnpm tsx scripts/smoke-http.ts` (route handlers on a real minted admin JWT), `pnpm tsx scripts/make-e2e-admin.ts` (temp admin, prints its id — delete after). They create real data. Unit tests mock Supabase and cannot see triggers/constraints; smoke tests caught production-breaking bugs the unit suite missed.
- **Stale dev servers**: `pnpm -r --parallel` does not kill previous instances → check `lsof -nP -iTCP:3000 -sTCP:LISTEN` before `pnpm dev` (web also dies with EADDRINUSE).
- `pnpm add` from non-TTY/agent shells needs a `CI=true` prefix (`ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`). Keep vitest on 2.x (3.x breaks against web's Vite 8 / TS 6 combo).

## Environment

- **Entorno de desarrollo = stack LOCAL de Supabase** (Supabase CLI + Docker), persistente (volumen) y aislado tanto del CI como del proyecto alojado anterior. Configuración en `supabase/ci/config.toml`; el stack vive en `~/supabase-dev/onano-support-dev`.
  ```bash
  cd ~/supabase-dev/onano-support-dev && supabase start   # levanta el stack
  bash scripts/dev/local-env.sh                           # escribe apps/*/.env con sus claves
  pnpm --filter @crm/api db:migrate                       # esquema del repo (22 migraciones)
  pnpm --filter @crm/api exec tsx scripts/seed-synthetic.ts   # usuarios y datos sintéticos
  ```
  En esta máquina el runtime es **colima** (`colima start --cpu 2 --memory 4 --disk 30`); Docker no viene instalado.
- **El proyecto alojado anterior queda en modo CONSULTA**: sus credenciales están en `apps/api/.env.legacy` y `apps/web/.env.legacy`. No se le escribe nunca. Su esquema fue **restaurado por la plataforma** (PITR a 2026-10-26) y conserva 2 cuentas, 3 clientes y 3 tickets; no hay conversaciones, mensajes ni adjuntos. Copia privada del historial recuperable: `bash scripts/dev/export-legacy-copy.sh`.
- **El esquema que protege a la base vive FUERA de la base**: `supabase/migrations/*.sql` en el repo. `public.schema_migrations` es solo contabilidad de lo ya aplicado; si el ledger y el repo discrepan, el repo manda.
- `apps/api/.env` (gitignored): `SUPABASE_URL`, `SUPABASE_SECRET_KEY` (service role = DB superuser; never in the browser), `DATABASE_URL` (scripts only), `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (SSR cookie client), `TWILIO_AUTH_TOKEN`, `CORS_ORIGINS` (comma list for prod; dev allows any localhost origin).
- Env lives in `apps/api/.env`: Next.js reads `.env` and `.env.local`, but the **scripts** use `dotenv/config`, which only reads `.env` — the error message in `src/lib/supabase/admin.ts` pointing at `.env.local` is misleading. Run script commands via `pnpm --filter` (or `cd apps/api`) so cwd is `apps/api`.
- `apps/web/.env`: `VITE_API_BASE_URL` (defaults to `http://localhost:3000`), `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`.

## Invariants

- **Layers**: routes validate (Zod), check permissions, translate errors to status codes; the business logic and its SQL live in `src/services/`, which throws typed errors carrying `status` + `code`. Several list routes still query the admin client inside the handler (`/api/tickets`, `/api/categories`, `/api/contacts`, `/api/users`) — that is legacy, not the template: new endpoints delegate to a service.
- **Permissions are data**: `permissions` catalog → `roles` keyring → `profiles.role_key`; SQL `resolve_permissions()` → `/api/me` → SPA. Guard with `requirePermission([...])` from `src/lib/auth.ts`; `requireRole` is legacy — do not use in new code. A PATCH mixing fields with different permissions must require the exact key per field touched (see `PATCH /api/tickets/[id]`). An empty keyring is a valid answer: client `canWith()` checks `permissions != null`, never `length > 0`.
- **`profiles.role` is legacy**; `role_key` is the truth. Trigger `handle_new_user` owns the `profiles` INSERT on auth signup — user-creating code UPDATEs that row (an INSERT violates `profiles_pkey`; mocks cannot catch this, smoke tests can).
- **service_role bypasses RLS**, so write restrictions are GRANT/REVOKE, not policies (`ticket_history` is append-only via REVOKE). A policy alone is decorative against the only client the app uses.
- **`anon` and `authenticated` have NO privileges on `public` (E1)**: the SPA uses the publishable key for the auth session only, and the API talks with `service_role`. Direct REST access to the data does not exist, and `profiles` self-edit is impossible. Do not "fix" a permission problem by adding a policy: the privilege is what was missing.
- **Who may edit what (E1)**: own personal fields (`display_name`, `phone`) via `PATCH /api/me`, whose body IS the allowlist (`z.strictObject`); role, suspension and permissions only through the admin flow (`PATCH /api/users/[id]`, `PATCH /api/roles/[id]`). Those two admin paths call the SQL functions `admin_update_profile` / `admin_replace_role_permissions`, which write the change AND the `admin_audit_log` entry in the same transaction — keep it that way (two calls would leave a role changed with no trail).
- **Twilio credentials do not live in `profiles`**: the columns were dropped (nothing read them and the read policy exposed them). Secrets go in the environment, never in a user row.
- **Soft delete**: `deleted_at` is an axis separate from `status`. Work lists filter `.is('deleted_at', null)`; trash uses `.not(...)`.
- **A ticket without `theme_id` is invisible on the board** (Pipeline filters `theme_id != null`). `pipeline_stages` / `conversation_stages` are dead tables (0 rows, 0 code refs); `themes` + `flows` are the live ones ("Proyectos" + fases).
- **Role color lives in two tables** (`roles.color` badges, `role_color_settings.base_color` message bubbles); the bidirectional mirror lives in the services, not the UI.
- **Customer identity = E.164-normalized phone**, on write *and* on search (`normalizePhone` in `src/lib/phone.ts`).
- **`z.strictObject`** when the body allowlist is the point of the endpoint (`/api/me`); other ticket routes use plain `z.object`, so per-field permission gating is their real allowlist.
- **Schema change** = new migration `<timestamp>_<name>.sql` + `db:migrate`; never edit an applied migration; backend and client contract changes ship in the same commit.
- **Next.js 16 with `cacheComponents: true`** — not the Next you know: read `node_modules/next/dist/docs/` before writing API code. `next dev` re-injects `apps/api/AGENTS.md`; commit that file along with your work.
- **Type strictness is per-app, not inherited**: `tsconfig.base.json` is orphaned (nothing extends it). `apps/api/tsconfig.json` runs plain `strict` with **no** `noUncheckedIndexedAccess` — index access there is `T`, not `T | undefined`; only `apps/web/tsconfig.app.json` sets `noUncheckedIndexedAccess: true`. Vitest has `globals: false` (import `describe/it/expect`); alias `@` → `src` in both apps.

## Twilio

- Inbound is real: `POST /api/webhooks/twilio` (+ `/status`) with hand-rolled HMAC-SHA1 signature validation (`src/lib/twilio-signature.ts`; skipped when `TWILIO_AUTH_TOKEN` is unset). Skips and processing errors return **200** so Twilio does not retry in a loop; errors go to the log. **An invalid signature returns 403 — never relax it to 200**, that would accept forged inbound messages.
- **No outbound sending exists**: nothing calls the Twilio SDK; `appendOutboundMessage` only records to the DB. The signature is validated against `request.url`, which breaks behind a reverse proxy until `WEBHOOK_BASE_URL` is wired in (known pending item).

## Conventions

- Product nomenclature: **"Proyectos"** (not Temas) and **"Clientes"** (not Contactos) — operator decision, do not revert. Clients never log in; users do.
- Commits: conventional commits matching history style (mostly Spanish subjects), no AI attribution. The `pre-commit` hook runs a GGA code review and **fails the commit** unless it gets a provider and a format-compliant agent: `GGA_PROVIDER=opencode GGA_OPENCODE_AGENT=general git commit -m "..."`. GGA v2.10.1's own config loader is broken on macOS (BSD `sed` rejects its `\xef\xbb\xbf` BOM strip, so `PROVIDER` from `~/.config/gga/config` never loads), and strict mode needs a `STATUS: PASSED|FAILED` line in the first 30 lines of the review — the default agent does not emit it. GGA also requires a root `AGENTS.md` to exist as its rules file.

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# whatsapp-CRM — multi-user WhatsApp CRM

Monorepo of two apps under `apps/*` (pnpm workspaces) sharing one Supabase project: a Next.js API that owns all data access, and a Vite SPA that never touches Postgres.

## Visión y alcance

CRM interno de ONANO Global para gestionar incidencias (pagos, registros, red, envíos) ligadas a clientes y atender conversaciones de WhatsApp (Twilio) en equipo. Los clientes son registros sin login; los usuarios son Admin, Supervisor y Soporte **más roles personalizados que un Admin crea desde la UI**.

`PRODUCT_SPEC.md` (raíz del repo) es la **fuente de verdad del alcance final**. Define los requisitos C1-C3, T1-T6, P1-P2, R1-R3, A1, W1-W4, D1 y el lote de operación O1-O12, con el estado ✅/⚠️/❌ de cada uno.

**Regla de trabajo:** antes de empezar cualquier tarea, lee `PRODUCT_SPEC.md`. Al terminarla, actualiza el estado de los requisitos afectados en ese mismo archivo.

## Stack (lo que hay en el árbol, no lo que dice el README)

El `README.md` raíz refleja el estado real del proyecto. Lo que hay en el árbol:

- **`apps/api/`** — Next.js 16.4.6 (App Router, `:3000`), TS strict, Zod 4, clientes Supabase server + admin. 42 route handlers bajo `src/app/api/`.
- **`apps/web/`** — React 19 + Vite (`:5173`), Tailwind v3, Zustand, React Router v6. Cero acceso a Postgres: todo pasa por la API.
- **`supabase/migrations/`** — 20 migraciones SQL. **El esquema vive aquí, no en Prisma/Drizzle.**
- **`apps/api/src/middleware.ts`** — CORS. Sin él el SPA ve "Load failed" en cada `fetch` cross-origin.
- **`apps/api/scripts/db.ts`** — herramienta admin contra Postgres directo (supera RLS).

## Commands

```bash
pnpm install
pnpm dev / dev:api / dev:web     # paralelo por defecto
pnpm build                       # tsc -b + next build + vite build
pnpm typecheck                   # en la API: next typegen + tsc --noEmit; en web: tsc -b --noEmit
pnpm test                        # vitest run (api + web)
pnpm lint                        # oxlint (solo web)
pnpm e2e                         # Playwright

# Un solo archivo / un solo caso
pnpm --filter @crm/api test src/services/users.test.ts
pnpm --filter @crm/api test -t "createUser"       # por nombre de test
pnpm --filter @crm/web test:e2e                   # Playwright
pnpm --filter @crm/web test:e2e --headed

# E1: quién puede cambiar cada campo protegido (base real, tokens reales)
pnpm --filter @crm/api test:integration

# Playwright protegido: sin esto los tests con sesión hacen skip en silencio
E2E_EMAIL=... E2E_PASSWORD=... pnpm --filter @crm/web test:e2e
```

**Verificación reproducible (idéntica a CI):** `CI=true pnpm install --frozen-lockfile` → `pnpm --filter @crm/api typegen` → `pnpm typecheck` → `pnpm test` → `pnpm --filter @crm/web lint` → `pnpm build`. El job de E2E de CI va aparte: levanta una **instancia efímera de Supabase**, aplica las migraciones con el ejecutor del repo, siembra datos sintéticos y corre las pruebas autenticadas. Si no corrieron pruebas autenticadas, el job falla y E1 queda PENDIENTE. El workflow acepta `controlled_failure` (`unit|lint|build|e2e`) para demostrar que una puerta se pone roja.

El paso `typegen` no es opcional: `apps/api` usa el global `LayoutProps` que Next genera en `.next/types`, así que sin `next typegen` un checkout limpio falla con `TS2304: Cannot find name 'LayoutProps'`. Node 22+ (`.nvmrc`); pnpm 11.22.0 sale de `packageManager` — si además lo fijás en `pnpm/action-setup`, la acción aborta con «Multiple versions of pnpm specified».

`pnpm lint` **hoy sale con código 0**: oxlint falla por errores, no por warnings. Quedan **24 warnings y 0 errores**, y la mayoría de los warnings son preexistentes (`set-state-in-effect` y `exhaustive-deps` en el mismo patrón de carga de datos de casi todas las páginas). El único error que había (`react-hooks/rules-of-hooks` sobre el fixture de Playwright, cuyo callback no puede llamarse `use` ni empezar por `use`) ya está corregido.

```bash
pnpm --filter @crm/api db:migrate              # aplica migraciones en orden
pnpm --filter @crm/api db:exec "<SQL>"        # una sentencia o ./ruta.sql
pnpm --filter @crm/api db:query <tabla>
pnpm --filter @crm/api db:tables
```

El ejecutor es honesto: una migración que revierte (objeto duplicado, por ejemplo) queda **PENDIENTE**, no se registra en `schema_migrations` y el proceso sale con código ≠ 0. «already exists» no acredita que la migración se haya completado.

**Verificación contra la base real** — estos existe porque los unit tests no pueden ver triggers, columnas inexistentes ni constraints:

```bash
cd apps/api
pnpm tsx scripts/smoke-batch.ts    # servicios contra la DB (crea y destruye una cuenta)
pnpm tsx scripts/smoke-http.ts     # route handlers sobre un JWT real
pnpm tsx scripts/make-e2e-admin.ts # cuenta admin temporal para E2E — bórrala después
```

`smoke-batch.ts` restaura lo que modifica. Los dos crean datos reales: nunca los corras contra una base compartida.

## Arquitectura: el modelo de permisos

Lo único que hay que entender antes de tocar casi cualquier cosa.

**Los permisos son datos; los roles son Hacazgos.** `public.permissions` es el catálogo de llaves (`ticket.assign`, `admin.manageRoles`…), `public.roles` agrupa esas llaves en un keyring, y `profiles.role_key` apunta a un rol por slug. La función `resolve_permissions(p_profile_id)` devuelve el keyring resuelto en un solo viaje; es lo que `/api/me` manda al SPA.

Esto significa tres cosas que no son obvias:

1. **Un rol vacío es una respuesta válida, no un fallo.** Un rol recién creado sin permisos debe seguir sin permisos. En el cliente, `canWith()` decide por `permissions != null` ("¿ya llegó el keyring?"), **nunca** por `length > 0` — esa comprobación le regalaría a un rol vacío todos los poderes de su columna `role` heredada.
2. **`requirePermission([...])` es el guard.** Ya no uses `requireRole(['admin'])` en código nuevo: no puede expresar "quien tenga la llave para reabrir", que es el punto entero de los roles personalizados. `requireAllPermissions` cuando hagan falta todas.
3. **Mezcla campos con permisos distintos en un PATCH → pide la llave exacta de lo que toca.** Ver `PATCH /api/tickets/:id`: renombrar es `ticket.update`, reasignar es `ticket.assign`, mover de fase es `ticket.moveFlow`. Pedir la unión dejaría que quien solo puede renombrar también reasigne.

`profiles.role` (columna legacy, `check in ('admin','supervisor','soporte')`) **ya no es fuente de verdad** — `role_key` lo es. La columna se mantiene en sync solo para los tres slugs del sistema, porque `role_color_settings` y `ticket_messages.role_at_send` todavía la leen.

## Arquitectura: acceso a datos y defensa

- **Los route handlers llaman a `services/`, nunca a Supabase directo.** La lógica de negocio y sus errores tipados (`ThemeError`, `TicketValidationError`, `UserValidationError`) viven en `src/services/`; las rutas solo traducen a status codes.
- **La API usa el cliente `service_role`, que BYPASSES RLS.** Las políticas RLS no protegen nada contra el único cliente que la app usa. Para lo que habla con `service_role`, la defensa real es a nivel de GRANT: `ticket_history` es append-only porque tiene `REVOKE UPDATE, DELETE, TRUNCATE ... FROM service_role`, no por una política. Si añades una restricción de escritura, revoca el privilegio; una política sola es decorativa.
- **`handle_new_user` es un trigger AFTER INSERT sobre `auth.users`** y ya inserta la fila en `profiles` (con `display_name` derivado del email y `role='soporte'`). Cualquier código que cree un usuario **actualiza** esa fila; insertarla viola `profiles_pkey`. Un mock de test no tiene triggers — solo el smoke test contra la DB real lo detecta.
- **Soft delete:** `deleted_at` + índices parciales. Las listas de trabajo filtran `.is('deleted_at', null)` y la papelera usa `.not(...)`. Es un eje aparte de `status`.
- **Cerrar acopla la fase:** `POST /api/tickets/:id/close` salta a la fase terminal de mayor posición del proyecto; reabrir baja a la primera no terminal.

## Arquitectura: dos conceptos que se confunden

El esquema tiene **tres** nociones de "etapa" y solo una está viva:

| Tabla | Estado |
|---|---|
| `themes` + `flows` | **Viva.** "Proyectos" y sus fases. Es lo que mueve el tablero. |
| `pipeline_stages` | Muerta. 0 filas, **0 referencias en todo el código**. |
| `conversation_stages` | Muerta. Igual. |

Un ticket sin `theme_id` **no aparece en el tablero** — `PipelinePage` filtra `theme_id != null`. "Asignar a un proyecto" no es una feature separada: es lo que hace un ticket visible.

**Nomenclatura (cambiada a pedido del operador — no la reviertas):** "Temas" → **Proyectos** (ícono `FolderKanban`), "Contactos" → **Clientes**.

**El color de un rol vive en dos tablas:** `roles.color` (badges) y `role_color_settings.base_color` (burbujas de mensajes, vía CSS vars `--role-admin`). El espejo bidireccional vive en los **servicios**, no en la UI, para que cualquier ruta que toque el color deje las dos alineadas. Un rol personalizado solo llega a `roles`; la UI lo dice explícitamente.

## Conventions

- **Esquema = SQL.** Tabla o columna nueva → migración nueva (`<timestamp>_<nombre>.sql`) + `db:migrate`. Nunca edites una migración ya aplicada.
- **`api.get/post/put/patch/del`** desde `apps/web/src/lib/api.ts`: inyecta el Bearer y lanza `ApiError(status, code, message)`.
- **Identidad de cliente = E.164 normalizado**, en escritura *y* en búsqueda. Dos registros para una persona parten su historial.
- **`z.strictObject` cuando el allowlist del body ES el punto del endpoint.** Con `z.object`, Zod descarta claves desconocidas: mandar `role` a `PATCH /api/me` devolvía 200 sin escribir nada. Seguro, pero le decía al cliente "guardado" cuando no había guardado.
- **Tailwind: `brand` + `role.{admin,supervisor,soporte}`.** Los colores de rol se aplican como custom properties en `:root` desde `/api/role-colors`.
- **La strictness es por app, no heredada**: `tsconfig.base.json` está huérfano (nadie lo extiende). `apps/api/tsconfig.json` corre `strict` plano **sin** `noUncheckedIndexedAccess` — ahí el acceso a índices devuelve `T`, no `T | undefined`; solo `apps/web/tsconfig.app.json` activa `noUncheckedIndexedAccess: true`.

## Critical caveats

- **`apps/api/scripts/db.ts` y los smoke tests usan `DATABASE_URL` (superuser) y el service-role key.** Nunca los apuntes a una base compartida o de producción.
- **Los E2E protegidos hacen `skip` si faltan `E2E_EMAIL`/`E2E_PASSWORD`.** Un "todo verde" puede ser 0 tests ejecutados. Un E2E que toque datos reales debe crear su propia fila y borrarla en `finally` — renombrar una fila de producción "funciona" y aun así destruye información.
- **`next dev` reinyecta `apps/api/AGENTS.md`** en cada arranque; no lo borres a mano. Next.js 16 tiene breaking changes: lee `node_modules/next/dist/docs/` antes de escribir código de API.
- **Stale dev servers.** `pnpm -r --parallel` no mata una instancia anterior. Antes de arrancar: `lsof -nP -iTCP:3000 -sTCP:LISTEN`. Matar solo la API no basta: la mitad web morirá igual con EADDRINUSE.
- **Twilio: los webhooks son reales, el envío saliente no.** `POST /api/webhooks/twilio` valida firma HMAC-SHA1 y registra mensajes entrantes; `/status` actualiza estados por SID. **No hay llamada al SDK de Twilio** — nada envía realmente por WhatsApp todavía.
- **`pnpm` v11 con workspaces.** No introduzcas `package-lock.json` ni `yarn.lock`.
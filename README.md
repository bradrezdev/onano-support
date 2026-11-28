# WhatsApp CRM — ONANO Global

CRM interno para gestionar incidencias (pagos, registros, movimientos de red, envíos) ligadas a clientes, y para atender conversaciones de WhatsApp en equipo.

Los **clientes** no inician sesión: son registros de control interno. Los **usuarios** del sistema son Admin, Supervisor y Soporte, más los roles personalizados que un Admin crea desde la UI.

---

## Índice

- [Stack](#stack)
- [Arquitectura](#arquitectura)
- [Base de datos](#base-de-datos)
- [Roles y permisos](#roles-y-permisos)
- [Twilio](#twilio)
- [Puesta en marcha](#puesta-en-marcha)
- [Flujo de trabajo](#flujo-de-trabajo)
- [Verificación](#verificacion)
- [Estructura del repositorio](#estructura-del-repositorio)
- [Consideraciones operativas](#consideraciones-operativas)

---

## Stack

| Capa | Tecnología |
|---|---|
| **API** | Next.js 16.4.6 (App Router) · TypeScript strict · Zod 4 · puerto 3000 |
| **Web** | React 19 · Vite · Tailwind v3 · Zustand · React Router v6 · puerto 5173 |
| **Datos** | Supabase (Postgres + Auth + Realtime + Storage) |
| **Mensajería** | Twilio WhatsApp (webhooks entrantes + estados) |
| **Paquetes** | pnpm v11 con workspaces |
| **Tests** | Vitest 2 (unit + integración) · Playwright (E2E) · smoke scripts contra la DB real |

**Una regla estructural:** el SPA nunca habla con Postgres. Todo pasa por la API, que es la única que conoce el esquema.

---

## Arquitectura

```
┌─────────────────┐        Authorization: Bearer <jwt>        ┌──────────────────┐
│  apps/web       │ ────────────────────────────────────────▶ │  apps/api        │
│  React 19 SPA   │ ◀──────────────────────────────────────── │  Next.js 16      │
│                 │         JSON + ApiError(status, code)      │  42 route        │
│  Zustand store  │                                           │  handlers        │
│  apiFetch()     │                                           │        │         │
└─────────────────┘                                           │        ▼         │
                                                              │  src/services/   │
                                                              │  lógica + SQL    │
                                                              └────────┬─────────┘
                                                                       │
                                                        service_role │ (BYPASSES RLS)
                                                                       ▼
                                                              ┌──────────────────┐
                                                              │  Supabase       │
                                                              │  Postgres + Auth│
                                                              └──────────────────┘
```

**Las tres capas y qué les corresponde:**

| Capa | Responsabilidad | No debe |
|---|---|---|
| `apps/web/src/pages` | Render, interacción, estado de UI | Hablar con Supabase directamente |
| `apps/api/src/app/api` | Validar entrada (Zod), traducir a status codes, chequear permisos | Ejecutar queries |
| `apps/api/src/services` | Toda la lógica de negocio y las queries | Saber de HTTP |

Los servicios lanzan errores tipados (`TicketValidationError`, `ThemeError`, `RoleValidationError`, `UserValidationError`, `ConversationError`, `AttachmentError`, `LinkError`) con `status` + `code`. Las rutas los traducen. Una validación que devuelve 400 desde el servicio es un acierto: el error de negocio y el de transporte se mantienen separados.

---

## Base de datos

Postgres de Supabase, 24 tablas, esquema 100% en SQL (no Prisma ni Drizzle). La migración se aplica con `db:migrate`, que corre los archivos de `supabase/migrations/` en orden y es idempotente.

### Dominio: identidad y permisos

| Tabla | Propósito |
|---|---|
| `profiles` | Una fila por usuario. `role_key` apunta al rol; `role` es la columna legacy sincronizada solo para los tres slugs del sistema |
| `roles` | Catálogo de roles. `key` es el slug estable; `is_system` marca los tres que no se pueden borrar |
| `permissions` | Catálogo de 34 llaves de permiso, con `label` y `group_name` |
| `role_permissions` | Keyring: qué rol tiene qué llave. many-to-many con `granted_by` |
| `role_color_settings` | Color y desvanecido por rol, para las burbujas de los mensajes |
| `admin_audit_log` | Bitácora **append-only** de acciones administrativas (rol, suspensión, permisos). El cambio y su registro se escriben en la misma transacción |

### Quién puede cambiar qué (E1)

`anon` y `authenticated` **no tienen ningún privilegio sobre `public`**: la app habla con la base solo con `service_role`, y el SPA usa la clave publicable únicamente para Auth. Por eso el acceso directo a los datos por REST no existe, y la autoedición de perfil tampoco.

| Actor | Campos que puede cambiar | Vía |
|---|---|---|
| Cualquiera (su propio perfil) | `display_name`, `phone` | `PATCH /api/me` — el cuerpo es el allowlist completo (`z.strictObject`); cualquier otra clave se rechaza, no se ignora |
| Admin con `admin.assignRole` | `role_key`, `suspension`, `display_name` de otro usuario | `PATCH /api/users/[id]` → `admin_update_profile` (transaccional + auditado) |
| Admin con `admin.manageRoles` | Permisos de un rol | `PATCH /api/roles/[id]` → `admin_replace_role_permissions` (transaccional + auditado) |

Las columnas de credenciales de Twilio se eliminaron de `profiles`: ningún código las leía y la política de lectura las exponía a cualquier usuario autenticado.

### Dominio: clientes y conversaciones

| Tabla | Propósito |
|---|---|
| `contacts` | Clientes. `whatsapp_number` en E.164 y único; búsqueda por nombre con índice trigram (`gin_trgm_ops`) |
| `tags` / `contact_tags` | Etiquetas de cliente (many-to-many) |
| `conversations` | Hilo de WhatsApp por cliente. `assigned_agent_id`, `escalated_to_id`, contador de no leídos |
| `messages` | Mensajes de WhatsApp. `twilio_sid` para correlacionar con Twilio |
| `conversation_tickets` |many-to-many entre conversación y ticket |
| `notes` | Notas internas, optionally ancladas a un cliente o a una conversación |
| `pipeline_stages` / `conversation_stages` | **Reservadas, sin uso.** 0 filas y 0 referencias en el código |

### Dominio: proyectos y tickets

| Tabla | Propósito |
|---|---|
| `themes` | Proyectos. Agrupan fases |
| `flows` | Fases de un proyecto. `is_terminal` marca la fase de cierre; `group_key` mapea a un grupo compartido |
| `flow_groups` | Vocabulario compartido: `pendiente`, `en_trabajo`, `en_espera`, `terminado` |
| `categories` | Taxonomía de dos niveles (`parent_id` self-referente) |
| `tickets` | 22 columnas: cliente, categoría, proyecto, fase, asignado, estado, prioridad, `due_at`, `is_major`, `deleted_at` |
| `ticket_messages` | Respuestas internas dentro del ticket (distinto de `messages`, que es WhatsApp) |
| `ticket_message_attachments` | many-to-many que fija un mensaje de WhatsApp a un ticket como evidencia |
| `ticket_history` | Auditoría append-only: actor, acción, payload |

### Mecanismos que no se ven en el esquema

**Triggers.** La base hace trabajo que el código no tiene que hacer:

| Trigger | Efecto |
|---|---|
| `handle_new_user` | Al crear un usuario en Auth, inserta su fila en `profiles` con `display_name` derivado del email y `role='soporte'`. **El servicio actualiza esa fila, nunca la inserta** — insertarla viola `profiles_pkey` |
| `roles_protect_system` / `roles_protect_key` | Impiden borrar los roles del sistema y renombrar su `key` (referenciado por `profiles.role_key` y `role_color_settings.role`) |
| `*_touch_updated_at` | Mantienen `updated_at` en `contacts`, `categories`, `themes`, `flows`, `tickets` |
| `messages_bump_conversation` | Actualiza la conversación al llegar un mensaje |
| `conversations_reset_unread_on_assign` | Al asignar una conversación, reinicia el contador de no leídos |

**Funciones.**

| Función | Para qué |
|---|---|
| `resolve_permissions(p_profile_id)` | Resuelve el keyring completo de un usuario en un viaje. Es lo que consume `/api/me` |
| `ticket_history_is_append_only()` | Aserta la invariante del historial |
| `current_user_role_safe()` | Acceso al rol desde SQL sin filtrar filas |

**RLS: por qué hay `REVOKE` y no solo políticas.** El cliente `service_role` **bypasea RLS** — es la única credencial que usa la API. Una política RLS no protege nada contra él. La defensa real es a nivel de privilegio: `ticket_history` es append-only porque tiene

```sql
revoke update, delete, truncate on public.ticket_history from service_role;
grant select, insert on public.ticket_history to service_role;
```

La app solo hace `INSERT` ahí, así que el candado no le cuesta nada y ni siquiera la propia service key puede reescribir el historial. Si añades una restricción de escritura, revoca el privilegio: una política sola es decorativa.

**Soft delete.** `deleted_at` es un eje aparte de `status`. Las listas de trabajo filtran `.is('deleted_at', null)`; la papelera usa `.not(...)`. Los índices son parciales sobre las filas vivas.

---

## Roles y permisos

**El modelo: los permisos son datos, los roles son conjuntos de llaves.**

`public.permissions` es el catálogo de 34 llaves. `public.roles` agrupa esas llaves en un keyring. `profiles.role_key` apunta a un rol por slug. `resolve_permissions()` resuelve el keyring de un usuario en un viaje y `/api/me` lo entrega al SPA.

Un rol sin llaves es una **respuesta válida, no un fallo**: existe, se ve vacío, y el Admin lo llena. Nunca se degrada a "sin permisos = todo permitido".

### Catálogo de permisos (34 llaves en 6 grupos)

**Cuentas** — `admin.createUser` · `admin.suspendUser` · `admin.deleteUser` · `admin.assignRole` · `admin.manageRoles` · `admin.viewAudit` · `admin.viewAccounts`

**Clientes** — `contact.read` · `contact.create` · `contact.update` · `contact.delete`

**Categorías** — `category.create` · `category.update` · `category.delete` · `subcategory.create` · `subcategory.delete`

**Proyectos** — `theme.create` · `theme.delete` · `flow.create` · `flow.delete`

**Tickets** — `ticket.read` · `ticket.create` · `ticket.update` · `ticket.assign` · `ticket.close` · `ticket.reopen` · `ticket.moveFlow` · `ticket.reply` · `ticket.delete` · `ticket.markMajor`

**Conversaciones** — `conversation.read` · `conversation.assign` · `conversation.reassign` · `conversation.escalate`

### Roles precargados

| Rol | Sistema | Alcance |
|---|---|---|
| **Admin** | sí | Las 34 llaves. Acceso total, incluida auditoría y gestión de roles |
| **Supervisor** | sí | Opera el equipo: asigna, reabre, reasigna, mueve en el pipeline, marca incidencias mayores. Crea y edita categorías y proyectos, crea fases, gestiona clientes. **No** borra categorías, proyectos ni fases, y no toca cuentas ni auditoría |
| **Soporte** | sí | Atiende lo que toma: crea, edita y responde tickets, ve y responde conversaciones, pide apoyo, ve y crea clientes. No asigna, no cierra, no reabre |
| **Auditor** | no | Solo lectura de auditoría y respuesta en tickets. Creado desde la UI en `/roles` |

### El color vive en dos tablas

`roles.color` pinta los badges; `role_color_settings.base_color` pinta las burbujas de los mensajes, vía custom properties CSS (`--role-admin`). El espejo bidireccional está en los **servicios**, no en la UI, para que cualquier ruta que toque el color deje las dos alineadas — ya divergieron una vez (`admin` tenía `#5692ff` en una y `#85baff` en la otra). Un rol personalizado solo alcanza `roles`; la UI lo dice en vez de mostrar un color que aparenta estar vivo.

### Reglas de enforcement

- **Todo se verifica en el backend.** Ocultar un botón es un letrero sin puerta: cada ruta llama `requirePermission`, así que una petición fabricada se rechaza sin importar qué pinte el SPA.
- **Mezclar campos con permisos distintos en un `PATCH` exige la llave exacta de lo que toca.** En `PATCH /api/tickets/:id`: renombrar es `ticket.update`, reasignar es `ticket.assign`, mover de fase es `ticket.moveFlow`. Pedir la unión dejaría que quien solo puede renombrar también reasigne.
- **Un keyring vacío no hereda los poderes de la columna legacy.** El cliente decide por `permissions != null` ("¿ya llegó el keyring?"), nunca por `length > 0` — esa comprobación le regalaría a un rol recién creado todos los poderes de su `role` heredada.

---

## Twilio

### Variables de entorno

| Variable | Para qué | Estado |
|---|---|---|
| `TWILIO_ACCOUNT_SID` | Identificador de la cuenta | Configurada; **sin uso en código** |
| `TWILIO_AUTH_TOKEN` | Credencial con la que se valida la firma (SDK de Twilio) | **En uso y obligatoria** |
| `TWILIO_WHATSAPP_FROM` | Número emisor | Configurada; **sin uso en código** |
| `WEBHOOK_BASE_URL` | Origen **público** del webhook: la URL contra la que se valida la firma | **En uso y obligatoria** |

> Sin `TWILIO_AUTH_TOKEN` o sin `WEBHOOK_BASE_URL` el webhook responde **503** y no escribe nada: la validación de la firma nunca se omite.

### Webhooks

| Ruta | Método | Qué hace |
|---|---|---|
| `/api/webhooks/twilio` | POST | Mensajes entrantes. Valida la firma, crea el cliente si no existe, reutiliza (y reabre) su hilo del canal y registra el mensaje |
| `/api/webhooks/twilio/status` | POST | Estados de entrega (`queued`, `sent`, `delivered`, `read`, `failed`), correlacionados por `MessageSid` |

Para configurarlos en la consola de Twilio, apuntá el webhook de mensajes a `https://<tu-dominio>/api/webhooks/twilio` (método POST) y el de estados a `https://<tu-dominio>/api/webhooks/twilio/status`.

### Validación de firma

Con el paquete oficial `twilio` (`twilio.validateRequest`), contra la **URL pública**: `WEBHOOK_BASE_URL` (origen) + la ruta + el query string. **No** contra `request.url` de Next: detrás de un proxy el esquema/host/puerto son los internos y toda petición legítima caería en 403.

El fragmento de la URL no entra en el cálculo de la firma (ahí viajan los overrides de conexión de Twilio), así que la URL pública se reconstruye sin él.

### Recepción entrante

Todo el camino entrante se resuelve en **una** transacción (`accept_inbound_whatsapp`, `SECURITY DEFINER`, con bloqueo de aviso por cliente):

- El cliente se busca por número normalizado y **se crea si no existe** (con el nombre de perfil de WhatsApp cuando viene). Antes se descartaba.
- El hilo se busca por **(cliente, canal)** — `conversations.channel` — y se **reutiliza**. Si estaba `closed`, se **reabre** con el mismo `conversation_id`: no se crea un segundo hilo.
- El mensaje se inserta **ignorando un `MessageSid` repetido**, y la operación devuelve si se insertó de verdad: el contador de no leídos se mueve **una** vez.

El **acuse** es TwiML vacío (`<?xml version="1.0" encoding="UTF-8"?><Response></Response>`) y solo se emite cuando la recepción quedó guardada o se comprobó que ya lo estaba. Un `MessageSid` repetido recibe el mismo TwiML vacío: Twilio no debe reintentar un evento ya procesado.

Un **fallo temporal de almacenamiento responde 5xx, nunca 200**: un 200 sería un mensaje perdido sin que nadie lo note.

### Política de reintentos (piloto)

Por defecto Twilio reintenta **una** vez y solo ante fallo de conexión (`rc=1`, `rp=ct`): **un 5xx no se reintenta**. Para que se reintente hay que configurar la URL del webhook en la consola de Twilio con los overrides de conexión (`#rc=3&rp=5xx,ct,rt`) o con la Webhooks configuration API. Esos overrides viajan en el **fragmento** de la URL, que no forma parte de la firma. Es un requisito de configuración de la consola, no de código.

### Qué NO está cableado

- **No hay envío saliente.** No existe una llamada de envío al SDK de Twilio: nada manda por WhatsApp todavía. `appendOutboundMessage` registra el mensaje en la base pero no lo transmite.


---

## Puesta en marcha

### Requisitos

Node 22+, pnpm v11, y un proyecto Supabase (Postgres + Auth).

### 1. Dependencias

```bash
pnpm install
```

### 2. Variables de entorno

`apps/api/.env`:

```bash
SUPABASE_URL=https://<proyecto>.supabase.co
SUPABASE_SECRET_KEY=<service_role>       # backend only — nunca en el navegador
DATABASE_URL=postgresql://...            # para scripts/db.ts (superuser)

TWILIO_ACCOUNT_SID=AC...
TWILIO_AUTH_TOKEN=...
TWILIO_WHATSAPP_FROM=+52...
WEBHOOK_BASE_URL=https://<tu-dominio>
```

`apps/web/.env`:

```bash
VITE_API_BASE_URL=http://localhost:3000
VITE_SUPABASE_URL=https://<proyecto>.supabase.co
VITE_SUPABASE_ANON_KEY=<publishable key>
```

El prefijo es `VITE_` porque la web es una SPA de Vite: solo se expone al navegador lo que lleva ese prefijo. Los `NEXT_PUBLIC_*` son del backend (Next) y van en `apps/api/.env`.

`.env` y `.env.local` están en `.gitignore` a nivel de repo. Nunca los commitees.

### 3. Esquema

```bash
pnpm --filter @crm/api db:migrate
```

Aplica todas las migraciones de `supabase/migrations/` en orden. Es idempotente: volver a correrlo no rompe nada. Si una migración revierte, el ejecutor **detiene la secuencia**, la deja PENDIENTE (no la registra) y sale con código distinto de 0.

### 4. Primer usuario

El trigger `handle_new_user` crea el perfil de cualquiera que se registre, siempre como `soporte`. Para el primer Admin, creá el usuario desde la consola de Supabase (Authentication → Users) y después:

```bash
pnpm --filter @crm/api db:exec \
  "update profiles set role_key='admin', role='admin' where id='<uuid-del-usuario>';"
```

### 5. Arrancar

```bash
pnpm dev          # API :3000 + Web :5173 en paralelo
```

---

## Flujo de trabajo

### Comandos

```bash
pnpm install / dev / dev:api / dev:web
pnpm build         # tsc -b + next build + vite build
pnpm typecheck     # genera los tipos de ruta de la API y luego tsc --noEmit en ambos workspaces
pnpm test          # vitest run en api y web
pnpm lint          # oxlint (solo web)
pnpm e2e           # Playwright
pnpm clean
```

### Verificación reproducible (la misma que corre CI)

```bash
CI=true pnpm install --frozen-lockfile   # lockfile congelado
pnpm --filter @crm/api typegen            # tipos de ruta: DEBEN existir antes de tsc
pnpm typecheck
pnpm test
pnpm --filter @crm/web lint               # oxlint: falla por ERRORES (hoy 0 errores, 24 warnings)
pnpm build
```

El job de E2E de CI levanta una **instancia efímera de Supabase** (Docker del runner), aplica las migraciones con el ejecutor del repo, siembra usuarios y datos **sintéticos** y corre las pruebas autenticadas de verdad:

```bash
pnpm --filter @crm/api test:integration   # E1: quién puede cambiar cada campo protegido
```

`pnpm --filter @crm/api typecheck` ya ejecuta `next typegen` antes de `tsc`: `apps/api` usa el global `LayoutProps` que Next genera, y sin ese paso un checkout limpio falla con `TS2304: Cannot find name 'LayoutProps'`.

Node 22+ (`.nvmrc`), pnpm 11.22.0 (la versión sale de `packageManager`; no la fijes también en la acción de CI o la acción aborta con «Multiple versions of pnpm specified»).

El workflow acepta una entrada `controlled_failure` (`unit|lint|build|e2e`) que inyecta un fallo deliberado: sirve para **demostrar que la puerta correspondiente se pone roja**.

### Tests

```bash
pnpm --filter @crm/api test src/services/users.test.ts   # un archivo
pnpm --filter @crm/api test -t "createUser"               # un caso
pnpm --filter @crm/web test:e2e                           # Playwright
pnpm --filter @crm/api test:integration                   # E1 contra una base real
pnpm --filter @crm/web lint                               # oxlint
```

Los E2E protegidos hacen **skip silencioso** si faltan `E2E_EMAIL` y `E2E_PASSWORD`. Un "todo verde" puede ser cero tests ejecutados, así que en CI el conteo es una puerta: si no corrieron pruebas **autenticadas**, el job falla y E1 queda **PENDIENTE**:

```bash
E2E_EMAIL=... E2E_PASSWORD=... pnpm --filter @crm/web test:e2e
```

### Entorno de desarrollo

El entorno de desarrollo es un **stack local de Supabase** (Supabase CLI + Docker), persistente y aislado del CI y del proyecto alojado anterior:

```bash
cd ~/supabase-dev/onano-support-dev && supabase start   # levanta el stack
bash scripts/dev/local-env.sh                           # escribe apps/*/.env con sus claves
pnpm --filter @crm/api db:migrate                       # esquema del repo, en orden
pnpm --filter @crm/api exec tsx scripts/seed-synthetic.ts   # usuarios y datos sintéticos
```

El proyecto anterior queda en **modo consulta** (`apps/*/.env.legacy`): conserva 2 cuentas, 3 clientes y 3 tickets, sin conversaciones, mensajes ni adjuntos. **La causa del incidente de ese proyecto no está confirmada** (la plataforma comunicó una restauración; eso no prueba quién vació el esquema) — ver `docs/diagnostico-base-compartida.md`. `bash scripts/dev/export-legacy-copy.sh` deja una **copia privada** de lo recuperable.

El **esquema vive fuera de la base**: `supabase/migrations/*.sql` es la fuente de verdad; `public.schema_migrations` es solo contabilidad de lo ya aplicado.

Antes de habilitar datos reales, el validador da el veredicto:

```bash
pnpm --filter @crm/api exec tsx scripts/validate-access-controls.ts          # informe
pnpm --filter @crm/api exec tsx scripts/validate-access-controls.ts --strict # sale con 1 si algo queda PENDIENTE
```

Mientras el veredicto diga que el entorno no puede recibir datos reales, **el entorno se mantiene sintético**. Última corrida: **6 controles OK, 0 pendientes**.

### Autorización de conversaciones y adjuntos

- Escribir en un chat y transferirlo son operaciones **transaccionales** en la base (`append_outbound_message`, `reassign_conversation`, `take_conversation`): la validación del titular y el guardado ocurren en la misma operación, así que un chat que cambió de manos mientras el agente redactaba **no guarda nada** y la interfaz lo informa (`409 assignment_changed`).
- Transferir exige **motivo** y **versión vigente** (`{ assigned_agent_id, reason, expected_version }`); una versión obsoleta se rechaza con `409 version_conflict`. El cambio y su bitácora (`conversation_audit_log`) se escriben en la misma transacción.
- Los adjuntos se autorizan **por adjunto**: titular del ticket, titular del chat del mensaje, o admin/supervisor. Un ticket con evidencia de dos chats muestra toda al titular del ticket y solo la de su chat al agente que atiende ese chat.
- El archivo lo sirve la **API** (bytes, con `?download=1` para descargar): no hay URL firmada, porque sobrevivía a la pérdida de permiso. El bucket es privado y ya no tiene políticas para `authenticated`.
- **Desvincular no borra el objeto**: el borrado físico es una operación aparte (`POST /api/tickets/:id/attachments/:messageId/purge`) que exige admin/supervisor, que no quede ninguna referencia viva y que se haya pasado la ventana de conservación (`RETENTION_DAYS`), y deja bitácora en `attachment_purge_log`.

### Base de datos

```bash
pnpm --filter @crm/api db:migrate              # aplicar migraciones
pnpm --filter @crm/api db:exec "<SQL>"        # una sentencia o ./ruta.sql
pnpm --filter @crm/api db:query <tabla>
pnpm --filter @crm/api db:tables
```

El ejecutor de migraciones es honesto: una migración que revierte (por ejemplo, por un objeto duplicado) **queda PENDIENTE**, no se registra en `schema_migrations` y el proceso comunica el error con código de salida distinto de 0. El texto «already exists» no acredita que la migración se haya completado. `scripts/ci/prove-pending-migration.sh` lo demuestra en cada corrida de CI.

### Convenciones

- **El esquema es SQL.** Tabla o columna nueva → migración nueva (`<timestamp>_<nombre>.sql`) + `db:migrate`. Nunca edites una migración ya aplicada.
- **Las rutas llaman a servicios, nunca a Supabase directo.**
- **El cliente usa `api.get/post/put/patch/del`** de `apps/web/src/lib/api.ts`: inyecta el Bearer y lanza `ApiError(status, code, message)`.
- **Identidad de cliente = E.164 normalizado**, en escritura *y* en búsqueda. Dos registros para una persona parten su historial.
- **`z.strictObject` cuando el allowlist del body es el punto del endpoint.** Con `z.object`, Zod descarta claves desconocidas: mandar `role` a `PATCH /api/me` devolvía 200 sin escribir nada — seguro, pero mentiroso.
- **Los cambios de esquema en el backend y en el cliente van en el mismo commit.** El cliente compila contra un contrato que el backend expone.
- **El `PRODUCT_SPEC.md` es la fuente de verdad del alcance.** Antes de una tarea, leelo. Al terminarla, actualizá el estado de los requisitos afectados.

---

## Verificación

El proyecto tiene tres niveles, y el tercero existe por una razón concreta.

```bash
cd apps/api
pnpm tsx scripts/smoke-batch.ts    # servicios contra la DB real
pnpm tsx scripts/smoke-http.ts     # route handlers sobre un JWT real
pnpm tsx scripts/make-e2e-admin.ts # admin temporal para E2E (bórralo después)
```

**Por qué los smoke tests existen:** los unit tests mockean Supabase, y un mock no tiene triggers, ni columnas, ni constraints. En este proyecto eso ya encontró tres bugs que 355 tests unitarios dejaron pasar — entre ellos un `INSERT` duplicado contra `profiles` que **fallaría el 100% de las veces en producción** y que ningún mock podía detectar.

`smoke-batch.ts` restaura lo que modifica. Los dos crean datos reales: nunca los corras contra una base compartida.

**Estado actual:** 344 API + 34 web + 18 Playwright = **396 verde**. Build limpio.

> `pnpm lint` hoy sale con **código 0**: oxlint falla por errores, no por warnings. Quedan **24 warnings y 0 errores** — casi todos preexistentes (`set-state-in-effect` y `exhaustive-deps` en el mismo patrón de carga de datos de casi todas las páginas). El error que sí había (`react-hooks/rules-of-hooks` sobre el fixture de Playwright) se corrigió; el conteo se publica en el resumen del job de CI.

---

## Estructura del repositorio

```
apps/
  api/                      # Next.js 16 — App Router bajo src/app
    src/app/api/            # 42 route handlers (tickets, conversations, users,
                            #   roles, themes, categories, webhooks, me, dashboard…)
    src/middleware.ts        # CORS — sin él el SPA ve "Load failed"
    src/lib/                # auth.ts, permissions.ts, phone.ts, sanitize.ts,
                            #   validate.ts, supabase/{server,admin}
    src/services/           # lógica de negocio y queries (tickets, conversations,
                            #   users, roles, themes, categories, audit, inbox,
                            #   whatsapp-inbound…)
    scripts/                # db.ts (admin SQL) + smoke scripts
  web/                      # React 19 + Vite
    src/pages/              # Login, Dashboard, Inbox, ConversationDetail, Contacts,
                            #   ContactDetail, Categories, Tickets, TicketNew,
                            #   TicketDetail, Pipeline, Themes, FlowEditor, Users,
                            #   UserDetail, Roles, RoleColors, Audit, Trash, Profile
    src/components/         # layout/ (AppShell, Sidebar, Topbar, ProtectedRoute,
                            #   RoleGuard) · ui/ (RichTextEditor)
    src/lib/                # api.ts, permissions.ts, roleColors.ts, themes.ts, users.ts
    src/stores/auth.ts      # Zustand: sesión + keyring de permisos
    src/router.tsx          # createBrowserRouter con future v7_relativeSplatPath
    e2e/                    # Playwright
supabase/migrations/        # migraciones SQL — el esquema vive aquí (fuera de la base)
PRODUCT_SPEC.md             # fuente de verdad del alcance y estado de requisitos
CLAUDE.md                   # guía de trabajo para agentes y personas
```

---

## Consideraciones operativas

- **`scripts/db.ts` y los smoke tests usan `DATABASE_URL` (superuser) y la service-role key.** Nunca los apuntes a una base compartida o de producción.
- **`bash scripts/dev/backup-and-verify-restore.sh` demuestra el respaldo desde disco**: crea un respaldo autocontenido, detiene el origen, lo restaura en otra instancia y verifica identidad, permisos, relación cuenta-chat, historial y bytes del adjunto. Ver `docs/respaldos.md`.
- **El service-role key es un superusuario de la base.** Trátalo como tal. Nunca debe llegar al navegador — por eso vive solo en `apps/api/.env` y `SUPABASE_SECRET_KEY` no tiene prefijo público.
- **`next dev` reinyecta `apps/api/AGENTS.md`** en cada arranque; no lo borres a mano.
- **Instancias de dev zombis.** `pnpm -r --parallel` no mata una instancia anterior. Antes de arrancar: `lsof -nP -iTCP:3000 -sTCP:LISTEN`. Matar solo la API no alcanza — la mitad web revienta igual con `EADDRINUSE`.
- **La ruta de un ticket nuevo sin `theme_id` no aparece en el tablero.** El pipeline filtra `theme_id != null`. Asignar un proyecto no es una feature separada: es lo que hace un ticket visible.
- **El trigger `handle_new_user` es dueño de la creación de `profiles`.** Cualquier código que cree un usuario actualiza esa fila.
- **Nomenclatura del producto:** "Proyectos" (antes "Temas") y "Clientes" (antes "Contactos"). Los clientes no inician sesión; los usuarios sí. No son sinónimos.

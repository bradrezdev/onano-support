# CRM ONANO Global: Especificación del producto

**Objetivo:** herramienta INTERNA para gestionar incidencias de ONANO Global (pagos, registros, movimientos de red, envíos) ligadas a clientes, y para atender conversaciones de WhatsApp (vía Twilio) en equipo. Los "clientes" NO inician sesión: son registros de control interno. Los usuarios del sistema son Admin, Supervisor y Soporte, más los roles personalizados que cree un Admin.

> **Fuente de verdad del alcance final.** Esta especificación es la referencia. Si un requisito cambia, no se borra: se anota la fecha y el motivo. Si el código contradice la spec, se pregunta antes de decidir.
>
> **Estado de los requisitos**: ✅ Hecho · ⚠️ Parcial · ❌ Pendiente. Las notas entre paréntesis apuntan al archivo principal donde está (o debería estar) la implementación.
>
> **Última auditoría:** 2026-10-20 (recuento inicial: 8 ✅ · 8 ⚠️ · 3 ❌ · 1 por decidir).
> **Actualizada:** 2026-10-20 tras cerrar R1, T4, W2, W3, W4, A1 y la papelera (14 ✅ · 4 ⚠️ · 1 ❌ · 1 por decidir).
> **Actualizada:** 2026-10-20 tras cerrar R2 (roles personalizados con permisos por acción) — **17 ✅ · 2 ⚠️ · 0 ❌ · 1 por decidir**.
> **Actualizada:** 2026-10-20 tras cerrar R3 (rutas restantes migradas a permisos) y D1 ("Mi bandeja") — 18 ✅ · 1 ⚠️ · 0 ❌ · 0 por decidir.
> **Actualizada:** 2026-10-20 tras cerrar C2, C3 y T3 — 19 ✅ · 1 ⚠️ · 0 ❌ · 0 por decidir.
> **Corregido:** 2026-10-21 — el conteo anterior decía "21/21" y estaba mal. La spec tiene **20** requisitos (C1-C3, T1-T6, P1-P2, R1-R3, A1, W1-W4, D1), no 21.
> **Actualizada:** 2026-10-21 tras cerrar W1 (adjuntar mensajes al ticket) y acoplar cerrar/reabrir a la fase terminal — **20 ✅ · 0 ⚠️ · 0 ❌ · 0 por decidir**. Verificado con grep, no de memoria. Todos los requisitos de la spec están completos.
> **Actualizada:** 2026-10-21 tras el lote reportado por el operador (10 correcciones + 2 implementaciones, ver "Lote de operación") — **20 ✅ · 0 ⚠️ · 0 ❌ · 0 por decidir** más **12 requisitos O1-O12** ✅. 344 api + 34 web + 18 Playwright = 396 verde.

---

## Lote de operación (2026-10-21)

Reportado por el operador como "no puedo hacer X desde la UI". La causa no era siempre la misma, así que cada punto dice cuál era — porque el síntoma ("no puedo") escondía tres clases distintas de fallo: una feature nunca escrita, una clave de permiso sin ruta detrás, y un dato que ya existía pero se mostraba como UUID.

| # | Requisito | Estado | Causa real | Dónde |
|---|---|---|---|---|
| O1 | Editar el color de un rol desde la UI, sincronizado en `roles.color` **y** `role_color_settings` | ✅ | Los dos endpoints ya existían; nada los llamaba. Además las dos tablas **ya divergían**: `admin` tenía `#5692ff` en una y `#85baff` en la otra | `pages/RoleColorsPage.tsx`, `services/roles.ts`, `services/ticket-messages.ts`, migración `20251020090001` |
| O2 | Editar el nombre de una categoría | ✅ | `PATCH /api/categories/:id` existía; la UI no lo llamaba | `pages/CategoriesPage.tsx` |
| O3 | Asignar un ticket a una persona | ✅ | El backend aceptaba `assigned_to` en `POST /api/tickets`, pero el formulario nunca lo enviaba y el detalle lo mostraba como UUID de solo lectura | `pages/TicketNewPage.tsx`, `pages/TicketDetailPage.tsx` |
| O4 | Crear un usuario | ✅ | **`POST /api/users` no existía.** La clave `admin.createUser` estaba en el catálogo desde R2 sin ninguna ruta detrás, así que no había ni dónde hacer clic | `app/api/users/route.ts`, `services/users.ts`, `pages/UsersPage.tsx` |
| O5 | Asignar un ticket a un proyecto | ✅ | `tickets.theme_id` existía y el tablero lo exige (`PipelinePage` filtra `theme_id != null`), pero ninguna pantalla lo escribía: un ticket nuevo nunca aparecía en el pipeline | ambos pages de ticket |
| O6 | Renombrar "Temas" → "Proyectos" con ícono propio | ✅ | Etiqueta. Ícono anterior era `Palette` (pintura), que no significaba nada para un proyecto con fases → `FolderKanban` | `Sidebar.tsx`, `ThemesPage.tsx`, `FlowEditorPage.tsx`, `PipelinePage.tsx` |
| O7 | Renombrar "Contactos" → "Clientes" | ✅ | Etiqueta, en toda la UI (no solo el `h1`) | `Sidebar.tsx`, `ContactsPage.tsx`, `TicketsPage.tsx`, `TicketNewPage.tsx`, `InboxPage.tsx` |
| O8 | Mostrar nombres en "Detalles" en vez de UUID | ✅ | El dato existía; faltaba el endpoint que lo resolviera. `slice(0,8)` era un placeholder que se volvió feature | `app/api/tickets/[id]/context/route.ts` |
| O9 | Asignar al crear y desde el detalle | ✅ | Dos Superficie distintas sobre el mismo campo | ambos pages de ticket |
| O10 | Reasignar desde el detalle | ✅ | El `PATCH` ya exigía `ticket.assign`; faltaba el control | `pages/TicketDetailPage.tsx` |
| O11 | Página de perfil: nombre y teléfono propios | ✅ | `display_name` solo lo editaba un admin; no había columna de teléfono | `pages/ProfilePage.tsx`, `PATCH /api/me`, migración `20251020090000` |
| O12 | El bloque de identidad del topbar abre el perfil | ✅ | Era un `div` estático: se leía como etiqueta, no como "esto eres tú, éditalo" | `components/layout/Topbar.tsx` |

**Notas de arquitectura que salieron de este lote:**

- **Un color de rol son dos columnas.** El arreglo va en el servicio, no en la UI: `upsertRoleColor` ahora espeja hacia `roles.color` y `updateRole` espeja hacia `role_color_settings`. Cualquier ruta que toque el color deja las dos alineadas. Un rol personalizado solo llega a `roles` (la otra tabla está indexada por los tres slugs del sistema) y la UI lo dice, en vez de mostrar un color que aparenta estar vivo.
- **`profiles` la crea un trigger, no el servicio.** `handle_new_user` (AFTER INSERT sobre `auth.users`) ya inserta la fila con `display_name` derivado del email y `role='soporte'`. `createUser` la *actualiza*; insertarla viola `profiles_pkey`. Solo el smoke test contra la base real pudo detectar esto — un mock no tiene triggers.
- **`PATCH /api/me` usa `strictObject`.** Con `object`, Zod descarta las claves desconocidas: mandar `role` devolvía 200 sin escribir nada. Seguro, pero mentiroso. Rechazar es la respuesta honesta en un endpoint cuyaAllowlist son dos campos.
- **`GET /api/tickets/:id/context` resuelve las seis claves foráneas en un viaje**, no seis. Un UUID en un panel de detalles no es información: es una búsqueda que el lector tiene que hacer a mano.

---

## Clientes

- **C1.** CRUD de clientes (alta por Admin/Supervisor/Soporte), sin login.
  - ✅ Hecho — `apps/api/src/app/api/contacts/route.ts` (GET/POST), `apps/api/src/app/api/contacts/[id]/route.ts` (PATCH/DELETE). `apps/web/src/pages/ContactsPage.tsx` cubre el CRUD en UI.
  - Nota: el alta es para cualquier rol autenticado (Admin/Supervisor/Soporte). Coherente con la spec.

- **C2.** Ficha del cliente con tickets asignados, incidencias mayores e historial de temas.
  - ✅ Hecho — `GET /api/contacts/:id?detail=1` (`apps/api/src/app/api/contacts/[id]/route.ts` → `apps/api/src/services/contacts.ts`) devuelve en 4 consultas paralelas: el contacto, sus tickets, los marcados como incidencia mayor, sus conversaciones y el historial de temas agrupado. UI en `apps/web/src/pages/ContactDetailPage.tsx`, ruta `/contacts/:id`.
  - `tickets.is_major` (migración `20251020050000_major_incidents.sql`) es el juicio humano de qué cuenta como incidencia mayor — el sistema las cuenta, la persona decide cuáles califican. Índice parcial `tickets_major_contact_idx`.
  - Permiso `ticket.markMajor` (Admin/Supervisor): marcar mayor alimenta el resumen de escalamiento, así que no es una edición genérica. Soporte no lo tiene para no inflar el registro.

- **C3.** Búsqueda de clientes.
  - ✅ Hecho — `GET /api/contacts?q=` busca por nombre, teléfono y email a la vez (`or()` de tres ilike). Cuando el término parece un teléfono se normaliza a E.164 antes de comparar, para que "+34 612 345 678" encuentre "+34612345678" — sin eso la misma persona se parte en dos registros por formato (recomendación 15).

## Tickets

- **T1.** CRUD de tickets; cada ticket está ligado a un cliente.
  - ✅ Hecho — `apps/api/src/app/api/tickets/route.ts` (GET/POST con `contact_id` requerido), `apps/api/src/app/api/tickets/[id]/route.ts`. `apps/web/src/pages/TicketsPage.tsx` + `TicketDetailPage.tsx` + `TicketNewPage.tsx`.

- **T2.** Hilo de comentarios tipo X/Twitter para dar seguimiento al caso (Admin/Supervisor/Soporte pueden responder).
  - ✅ Hecho — `apps/api/src/app/api/tickets/[id]/messages/route.ts` + `apps/api/src/services/ticket-messages.ts`. Sanitización con `apps/api/src/lib/sanitize.ts` (TipTap → allowed marks).

- **T3.** Crear ticket desde un modal: buscar cliente o crearlo ahí mismo si no existe.
  - ✅ Hecho — `TicketNewPage.tsx`: búsqueda por nombre/teléfono/email y, cuando no hay resultados, botón "No es ninguno — crear contacto" que abre el formulario inline. Al crear, el contacto queda seleccionado automáticamente: el usuario vino a escribir un ticket, no a administrar el padrón.
  - Anti-duplicado: el botón "Crear y usar" se deshabilita si el teléfono ya existe entre los contactos, con aviso explícito. Dos carpetas para la misma persona parten su historial.
  - `?contact_id=` preselecciona el contacto cuando se entra desde la ficha (C2).

- **T4.** Abrir/cerrar: Admin, Supervisor, Soporte. Reabrir: Admin/Supervisor. Eliminar: solo Admin.
  - ✅ Hecho — Cerrar: `POST /api/tickets/:id/close` acepta admin|supervisor|soporte. Reabrir: `POST /api/tickets/:id/reopen` acepta admin|supervisor. Eliminar (papelera): `DELETE /api/tickets/:id` solo admin, con guard de papelera. La supresión es lógica (`deleted_at`), nunca física. Restaurar: `POST /api/tickets/:id/restore` (admin). Ver `apps/api/src/app/api/tickets/[id]/close/route.ts`, `…/reopen/route.ts`, `…/restore/route.ts`, `apps/api/src/services/tickets.ts` (trashTicket/restoreTicket) y `apps/web/src/pages/TrashPage.tsx`.
  - Nota: un ticket en papelera no se puede responder, reasignar ni cerrar — `findTicketOrThrow` filtra `deleted_at is null`. Cubierto por `apps/api/src/services/tickets.trash.test.ts`.

- **T5.** Categorías: Admin/Supervisor crean; solo Admin elimina; Admin/Supervisor editan la categoría de un ticket.
  - ✅ Hecho (con ajuste: `apps/api/src/app/api/categories/route.ts` + `[id]/route.ts`; la edición de la categoría de un ticket es `PATCH /api/tickets/:id`).

- **T6.** Los tickets se mueven por un pipeline para saber en qué estado están.
  - ✅ Hecho — `apps/api/src/app/api/tickets/[id]/flow/route.ts` (cambia `flow_id` y `flow_order`). `apps/web/src/pages/PipelinePage.tsx` lo muestra con drag-and-drop (`@dnd-kit/core`).

## Proyectos y pipelines

- **P1.** Admin/Supervisor crean proyectos.
  - ✅ Hecho — `apps/api/src/app/api/themes/route.ts` (temas/proyectos) + `[id]/route.ts`. Permiso `theme.create` lo tienen admin y supervisor.

- **P2.** Cada proyecto tiene su propio pipeline con fases nombradas por proyecto.
  - ✅ Hecho — `apps/api/src/app/api/themes/[id]/flows/route.ts` + `flows/[id]/route.ts`. `apps/web/src/pages/FlowEditorPage.tsx` permite crear y renombrar fases por proyecto.

## Roles y permisos

- **R1.** Solo Admin asigna/edita roles de otros usuarios y ve la lista de cuentas.
  - ✅ Hecho — `GET /api/users` y `GET /api/users/:id` exigen admin. `PATCH /api/users/:id` exige admin y bloquea auto-suspensión/auto-degradación (`self_suspend` / `self_demote`) para no dejar la cuenta huérfana. Ver `apps/api/src/app/api/users/route.ts` y `[id]/route.ts`.
  - Excepción deliberada: `GET /api/users/assignable` devuelve solo `{id, display_name, role}` de cuentas activas para cualquier rol autenticado. Sin esa lista mínima no se puede asignar un ticket (la UI no puede ofrecer responsables a Supervisor/Soporte). No expone email, suspensión ni actividad.

- **R2.** Admin crea roles nuevos y les asigna un color.
  - ✅ Hecho — Modelo de llavero: `public.permissions` (catálogo de llaves, 27), `public.roles` (nombre + color + `is_system`), `public.role_permissions` (qué rol tiene qué llave). `profiles.role_key` apunta al slug. Ver migraciones `20251020030000_custom_roles.sql` y `20251020030001_add_view_accounts_permission.sql`.
  - API: `GET /api/roles` (lista roles con su llavero + el catálogo), `POST /api/roles` (crear, `admin.manageRoles`), `PATCH /api/roles/:id` (nombre/color/permisos; la `key` NO es editable), `DELETE /api/roles/:id` (rechaza roles del sistema y roles con usuarios). Servicio en `apps/api/src/services/roles.ts`.
  - UI: `apps/web/src/pages/RolesPage.tsx` — lista de roles + cuadrícula de llaves por grupo. Un rol sin llaves es válido y se muestra con aviso explícito ("no tiene ninguna llave: no puede hacer nada todavía").
  - Protección a nivel DB: triggers impiden borrar un rol del sistema o cambiarle la `key`.
  - `role_color_settings` sigue atado a los tres slugs del sistema; un rol custom usa el color de `roles.color`.

- **R3.** Las reglas se aplican en backend/base de datos, no solo ocultando botones.
  - ✅ Hecho — `requirePermission(permisos, request)` y `requireAllPermissions` en `apps/api/src/lib/auth.ts` reemplazan la chequeada por rol en las rutas de acción. `AuthedUser` trae `permissions: Permission[]`, resueltas en una llamada con la función SQL `resolve_permissions(uuid)`. El 403 responde con `required: [...]` para que el cliente sepa qué falta.
  - Casos donde el permiso depende del body: `PATCH /api/users/:id` exige `admin.assignRole` si viene `role`, `admin.suspendUser` si viene `suspend` — no la unión, para que asignar rol no habilite suspender.
  - La UI (`canWith` en `apps/web/src/lib/permissions.ts`, `RoleGuard`) lee el keyring que envía `/api/me`; es una comodidad, no la defensa. El rechazo real vive en el handler.
  - Pendiente menor: la columna `profiles.role` y su `check` siguen existiendo como respaldo de los tres slugs del sistema. Se puede eliminar cuando se quiera, pero no aporta valor: `role_key` ya es la fuente de verdad y todas las rutas leen el keyring.

## Auditoría

- **A1.** Página con todos los movimientos de Supervisores/Soporte, visible solo para Admin.
  - ✅ Hecho — `GET /api/audit` (solo admin) agrega `ticket_history` + estado de conversaciones y filtra `profiles.role in ('supervisor','soporte')`. UI en `apps/web/src/pages/AuditPage.tsx`, ruta protegida por `RoleGuard allow={['admin']}` en `apps/web/src/router.tsx`.
  - El servicio (`apps/api/src/services/audit.ts`) es solo-lectura por construcción: no expone ninguna función de escritura, y la ruta no tiene POST/PATCH/DELETE. Los movimientos de Admin quedan fuera a propósito — la página vigila al equipo, no es un espejo.
  - Alcance real: es una foto (estado actual) en el lado de conversaciones, y un log de cambios real en el lado de tickets. Las conversaciones no tienen tabla de historial propia todavía (ver W1).

## WhatsApp (Twilio)

- **W1.** Desde una conversación se crean/asignan tickets y se seleccionan mensajes para adjuntarlos al ticket.
  - ✅ Hecho — `ticket_message_attachments` (migración `20251020060000_message_attachments.sql`): m2m real, un mensaje puede informar varios tickets y un ticket acumular mensajes de varias conversaciones.
  - Asimetría deliberada en las FK: `ticket_id → tickets ON DELETE CASCADE` (borrar el ticket se lleva sus adjuntos) pero `message_id → messages ON DELETE RESTRICT` (borrar un mensaje NO reescribe la historia del incidente; un registro que pierde su evidencia cuando alguien limpia un chat es peor que inútil).
  - API: `GET/POST /api/tickets/:id/attachments`, `DELETE /api/tickets/:id/attachments/:messageId`, `GET /api/conversations/:id/attachable?ticket_id=` (ofrece solo mensajes no adjuntos aún). Servicio `apps/api/src/services/message-attachments.ts` (13 tests).
  - Guards: no se puede adjuntar a un ticket en papelera, no se aceptan message_ids inexistentes, y Soporte no puede extraer evidencia de una conversación ajena aunque tenga la llave del ticket (`canAccessConversation` + `ticket.read`, dos puertas porque son dos sujetos).
  - UI: botón "Adjuntar al ticket" en la conversación pone checkboxes sobre las burbujas; el detalle del ticket muestra los mensajes fijados bajo "Mensajes adjuntos".

- **W2.** Admin/Supervisor leen todos los mensajes; Soporte solo los de las conversaciones que toma.
  - ✅ Hecho — Enforcement en backend, no en la UI. `canAccessConversation()` en `apps/api/src/services/conversations.ts` permite admin/supervisor leer cualquier conversación y a soporte solo las propias + la cola sin dueño. `GET /api/conversations/:id` devuelve **403** si no aplica; `GET /api/conversations` acota el listado por rol (con `?mine=true` soporte ve solo lo suyo). Cubierto por `apps/api/src/services/conversations.workflow.test.ts`.

- **W3.** Soporte puede pedir apoyo para que alguien más responda.
  - ✅ Hecho — `POST /api/conversations/:id/escalate { to_user_id }` registra la petición en `conversations.escalated_to_id/escalated_by_id/escalated_at`. **No transfiere la propiedad**: pedir apoyo es pedir, no entregar. UI: selector "Pedir apoyo a…" en `apps/web/src/pages/ConversationDetailPage.tsx`.

- **W4.** Admin/Supervisor reasignan una conversación a otro usuario.
  - ✅ Hecho — `PATCH /api/conversations/:id { assigned_agent_id }` (admin|supervisor). `null` devuelve la conversación a la cola. Rechaza asignar a cuentas suspendidas/borradas. UI: selector "Reasignar a…" + "Devolver a la cola" en `ConversationDetailPage.tsx`.
  - Complemento (recomendación 7, "Tomar"): `POST /api/conversations/:id/take` — cualquier rol toma una conversación sin dueño. Usa `UPDATE ... WHERE assigned_agent_id IS NULL` y devuelve **409** si otro la tomó primero, para que dos personas no se pisen en silencio. Botón "Tomar" en el detalle.

## Dashboard

- **D1.** "Mi bandeja" — qué hago ahora.
  - ✅ Hecho — `GET /api/dashboard` (`apps/api/src/app/api/dashboard/route.ts`) devuelve cuatro contadores y las filas detrás de ellos, scopeados al caller:
    1. **Mis tickets**: abiertos asignados a mí.
    2. **Vencidos**: mis tickets con `due_at < now()`. NULL nunca se cuenta como vencido — la ausencia de deadline no es un incumplimiento.
    3. **Sin asignar**: abiertos con `assigned_to is null`. La fila del súper.
    4. **Mensajes sin abrir**: conversaciones con `unread_count > 0`.
  - UI: `apps/web/src/pages/DashboardPage.tsx` montado en `/`. Cuatro tiles que colapsan al llegar a cero y secciones expandidas solo cuando hay contenido. Sin gráficas (recomendación 8: "tablero debe decir 'qué hago ahora'", no "30 relojes").
  - Migración nueva: `priority` enum + `due_at timestamptz` + índice parcial `tickets_due_open_idx` para que la query de vencidos no escanee tickets sin deadline. Recomendación 10 aterrizada.
  - `/tickets?assigned_to=me|none&overdue=1` filtra con un atajo: el cliente lo pasa y el admin lo reemplaza por `eq('assigned_to', auth.user.id)` / `is('assigned_to', null)`.

## Por decidir

- (vacío — el último ítem, D1, está resuelto arriba)## Funciones sugeridas (por confirmar, clasificar Must/Should/Later)

| Función | Clasificación sugerida |
|---|---|
| Responsable del ticket (`assigned_to`) | Must — ya en DB y parcialmente en UI |
| Prioridad/severidad | Should |
| SLA o fecha límite (`due_at`) | Should |
| Etiquetas | Later |
| Adjuntos (Storage propio, no solo `media_urls` Twilio) | Should |
| Menciones `@` y notificaciones | Later |
| Respuestas rápidas | Later |
| Estado de conversación + indicador de no leídos | Should — `unread_count` ya existe en `conversations` |
| Filtros y vistas guardadas | Should |
| Búsqueda global | Should |
| Exportar CSV | Later |
| Fusionar duplicados | Should |

## Criterios técnicos recomendados (confirmar)

- **Permisos por tabla rol → permiso (no roles hardcoded).** Estado: ✅. `public.permissions` + `public.roles` + `public.role_permissions`, `requirePermission` en todas las rutas, UI leyendo el keyring de `/api/me`. Ver R2/R3.
- **Auditoría solo-inserción** (quién, qué, cuándo, valor anterior/nuevo) y **eliminación lógica** de tickets. Estado: ✅ parcial. `ticket_history` registra `from_value`/`to_value` por cambio, y `tickets.deleted_at` da la eliminación lógica. Pendiente el segundo candado (RLS `USING (false)`) — ver recomendación 4.
- **"Abierto/cerrado" separado de "etapa del pipeline"**, y coherentes entre sí. Estado: ✅ — `tickets.status` (open/in_progress/closed) y `tickets.flow_id` + `flow_order` viven separados. El servicio `closeTicket` y `moveToFlow` ya coordinan.
- **Conversación y ticket relacionados muchos a muchos** (un ticket puede tener varios chats; un chat puede contener varios tickets). Estado: ⚠️ — hoy es muchos-a-uno vía `tickets.contact_id` (no vía conversación). Falta la m2m real.
- **Teléfono normalizado (E.164)** para vincular mensajes con clientes. Estado: ✅ — `apps/api/src/lib/phone.ts` (ver también `phone.test.ts`).
- **Los comentarios internos del ticket NUNCA se envían al cliente por WhatsApp.** Estado: ✅ por construcción. `ticket_messages` y `messages` son tablas distintas con rutas distintas: `/api/tickets/:id/messages` (notas internas, solo backend) y `/api/conversations/:id/messages` (WhatsApp real). El outbound de WhatsApp lee exclusivamente `messages`. No hay ninguna ruta que escriba un `ticket_message` hacia Twilio.
- **Twilio**: validar firma del webhook ✅, idempotencia por `MessageSid` ✅, callbacks de estado ✅ (parcial — `twilio/status`), ventana de 24 h y plantillas ❌, multimedia en storage propio ❌ (hoy guarda `media_urls` como strings). Estado: ⚠️.

## Definición de terminado

Todos los requisitos en ✅, los criterios técnicos cumplidos y la sección "Por decidir" resuelta.

---

## Recomendaciones adicionales (del equipo, принято)

1. **Permisos por acción, no por rol.** Definir acciones sueltas ("reabrir tickets", "ver auditoría") y que cada rol sea un paquete de ellas. El Admin puede crear roles nuevos, pero un rol sin nada que configurar es un gafete en blanco — es un llavero: las llaves son los permisos y el rol es el llavero. Además, el sistema debe rechazar la acción por dentro, no solo esconder el botón. Esconder el botón es un letrero de "prohibido pasar" sin puerta.
   → Estado: ✅. Catálogo `public.permissions` (27 llaves), `public.roles` (nombre + color + is_system), `public.role_permissions` (el llavero). `requirePermission` en el backend; la UI lee el keyring de `/api/me`. Un rol sin llaves se crea y se muestra vacío a propósito: es un gafete en blanco visible, no un fallo diferido.
   → Gotcha registrado: `canWith` en el frontend debe distinguir "el keyring no llegó" (`permissions === undefined`) de "el keyring llegó vacío" (`permissions === []`). Caer al fallback en el segundo caso le regalaría a un rol recién creado todos los poderes de su columna `role` legacy — exactamente lo contrario de un llavero vacío. Hay un test que lo cubre.

2. **Cerrar un ticket = llegar a la última fase.** Si "cerrado" y la fase van por separado, habrá tickets cerrados que siguen "En revisión".
   → Estado: ✅. `closeTicket` mueve el ticket a la fase terminal (`flows.is_terminal`) de su proyecto; `reopenTicket` lo devuelve a la primera fase no terminal. "Cerrado" y "terminado" son la misma idea, no dos. Solo aplica si el proyecto define una fase terminal — inventar una sería peor que la ambigüedad que se elimina.

3. **Papelera en vez de borrar.** Si un Admin elimina un ticket, que se oculte y quede registro. Un error humano no debe ser irreversible.
   → Estado: ✅. `tickets.deleted_at` + `deleted_by` (migración `20251020010000_soft_delete.sql`). `DELETE /api/tickets/:id` marca, no borra. `GET /api/tickets/trash` + `POST /api/tickets/:id/restore` (admin). UI `/tickets/trash`. Índices parciales `tickets_live_updated_idx` y `tickets_trashed_idx` para que la papelera no contamine los listados. Verificado end-to-end contra la DB.

4. **Auditoría que nadie pueda editar**, ni un Admin: quién, qué, cuándo y qué cambió. Es la caja negra del avión, que solo sirve si nadie puede alterarla.
   → Estado: ✅. Doble candado. La capa de aplicación (`apps/api/src/services/audit.ts`) no exporta escritura y `GET /api/audit` no tiene POST/PATCH/DELETE. Y a nivel DB: `REVOKE UPDATE, DELETE, TRUNCATE ON public.ticket_history FROM service_role`. La app solo hace INSERT (verificado en código), así que el candado no rompe nada, y `service_role` ya no puede reescribir el historial ni aunque quisiera. Comprobado en vivo: `set local role service_role; update ticket_history` devuelve "permission denied". Función pública `ticket_history_is_append_only()` documenta y aserta la invariante. Las correcciones legítimas (GDPR, errores) pasan por migración SQL revisada, no por aplicación.

5. **Fases con nombre propio pero en grupos comunes.** Cada proyecto nombra sus fases, pero todas pertenecen a uno de 4 grupos (Pendiente, En trabajo, En espera, Terminado). Es como un semáforo: cada ciudad tiene sus calles, pero el rojo significa lo mismo. Así podrás comparar todos los proyectos.
   → Estado: ✅. `public.flow_groups` con los cuatro grupos fijos y ordenados, `flows.group_key` opcional. El seed asigna por nombre solo las fases inequívocas; las ambiguas (ej. "Listo") quedan NULL honestamente y las clasifica un humano. La lista de fases (`GET /api/themes`) viaja con los cuatro grupos como vocabulario compartido. Falta exponer el selector en `FlowEditorPage.tsx`.

6. **Notas internas separadas de los chats.** Un comentario interno nunca debe llegar al cliente por accidente. El post-it de la oficina y la carta al cliente van en buzones distintos.
   → Estado: ✅ por construcción (ver criterio técnico equivalente). Tablas y rutas separadas; el flag explícito sería redundante.

7. **"Tomar" una conversación con reglas claras:** fila de chats sin dueño, botón "Tomar" y alerta si nadie lo toma. Es la fila de la caja del súper: si nadie levanta la mano, el cliente espera.
   → Estado: ✅ (parcial). `POST /api/conversations/:id/take` es atómico: `UPDATE ... WHERE assigned_agent_id IS NULL`, y devuelve 409 si otro llegó primero. Índice parcial `conversations_unassigned_idx` para que la cola no se ralentice al crecer. UI: botón "Tomar" en `ConversationDetailPage`. Falta mostrar el contador de "sin dueño" en la bandeja para que la alerta sea visible sin entrar a cada chat.

8. **Dashboard: empieza por "Mi bandeja".** Lo que me toca hoy, lo vencido, lo sin asignar. Un tablero debe decir "qué hago ahora". El del auto muestra gasolina y alertas, no 30 relojes.
   → Resuelto en D1: cuatro tiles en `/`, sin gráficas, cada uno enlaza a la lista detrás.

9. **Responsable en cada ticket.** Sin él, es un paquete sin repartidor: todos creen que otro lo atiende.
   → Estado: ✅ (campo `tickets.assigned_to`).

10. **Prioridad y fecha límite, con aviso de "vencido".** Lo urgente no se mezcla con lo normal y nada se olvida.
    → Estado: ✅. `tickets.priority` enum (low/normal/high/urgent) + `tickets.due_at` + índice parcial `tickets_due_open_idx` (D1). UI en `TicketDetailPage`: panel "Triaje" con selector de prioridad, fecha de vencimiento y botón "Marcar como mayor". Guard `ticket.markMajor` separado de `ticket.update` para que dar permisos de marcar mayor no le abra la puerta a editar cualquier campo.

11. **Avisos cuando te asignan algo, te piden apoyo o llega un mensaje.** Nadie mira la pantalla todo el día; es el timbre de la casa.
    → Estado: ❌. Requiere Realtime en `ConversationDetailPage` + notificaciones in-app para asignación/apoyo.

12. **Desactivar usuarios en vez de borrarlos.** Si alguien deja la empresa, pierde el acceso pero su historial se queda. Quitas el gafete, no borras su nombre del libro.
    → Estado: ✅ parcial — `suspended_at` + `deleted_at` en `profiles` (ver `apps/api/src/services/users.ts` y `users.test.ts`).

13. **Protección y privacidad:** verificación en dos pasos para Admin, copias de seguridad automáticas y decidir cuánto tiempo se guardan los mensajes y quién puede exportarlos. Los Admin lo ven todo y los chats traen datos personales y de pagos.
    → Estado: ❌. 2FA no implementado. Backup policy pendiente. Retención/exportación por definir.

14. **Las reglas de WhatsApp a la vista.** WhatsApp solo deja escribir libremente durante las 24 horas posteriores al último mensaje del cliente; después, solo con plantillas aprobadas. Muestra si esa ventana sigue abierta y si cada mensaje fue enviado, entregado, leído o falló. Si no, tu equipo creerá que respondió y el cliente nunca lo recibió.
    → Estado: ❌. No hay tracking de ventana 24h ni estados `delivered/read/failed` por mensaje (más allá de `twilio_status` recibido vía webhook).

15. **Evitar clientes duplicados, usando el teléfono como identificador y ofreciendo "crear cliente" cuando escriba un número desconocido.** Dos carpetas para el mismo cliente parten su historial.
    → Estado: ✅ parcial. `contacts.whatsapp_number` es UNIQUE y se normaliza a E.164 antes de guardar (`normalizePhone`), así que "+34 612 345 678" y "612345678" son la misma persona. La búsqueda (C3) usa la misma normalización, y T3 ofrece "crear contacto" inline con el botón deshabilitado si el teléfono ya existe. Falta el diálogo proactivo en el inbox cuando llega un número desconocido por webhook (hoy el webhook salta silenciosamente si no encuentra el contacto).

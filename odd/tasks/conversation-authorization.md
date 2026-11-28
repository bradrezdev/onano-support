# PR #2 · Autorización de conversaciones y adjuntos

Objetivo: cerrar la autorización de escritura en conversaciones y el acceso a adjuntos, con auditoría transaccional de transferencias y controles que fallen el CI cuando no se pueden verificar.
Rama: `feature/conversation-authorization` (apilada sobre `feature/e1-profile-protection`; el PR #2 se apila sobre el PR #1 y se fusiona después).
Entrega: commits sobre la rama; PR #2 → base `feature/e1-profile-protection`.
Test runner: `pnpm test` · `pnpm --filter @crm/api test:integration` · `pnpm --filter @crm/web test:e2e` · `apps/api/scripts/validate-access-controls.ts`.

## Specs

- **S1** «Autorizar cada escritura en el backend según el titular y el permiso del actor.»
- **S2** «Validar la asignación y guardar el mensaje en una misma operación atómica.»
- **S3** «Si el chat cambió de titular mientras el agente redactaba → informar del cambio en la interfaz y comprobar que no se guardó ni encoló el mensaje.»
- **S4** «Probar A → B y, por separado, A → cola.»
- **S5** «Exigir permiso, motivo y versión vigente.»
- **S6** «Guardar el cambio y su auditoría en una transacción: actor, titular anterior, nuevo titular, motivo y fecha.»
- **S7** «Tras A → B, comprobar que B puede responder y A pierde el acceso correspondiente.»
- **S8** «Dos solicitudes con la misma versión → un solo cambio y un solo evento.»
- **S9** «Crear un ticket con titular conocido y un archivo sintético con contenido.»
- **S10** «Elegir como agente ajeno a quien carezca de acceso tanto al ticket como al chat.»
- **S11** «Verificar listado, lectura, descarga y borrado en la API y en Storage.»
- **S12** «Repetir después de transferir.»
- **S13** «Incluir un caso permitido para el titular.»
- **S14** «Ejecutar estos controles en cada PR.»
- **S15** «Si falta un dato de prueba, se omite un caso obligatorio o aparece PENDIENTE → el job falla.»
- **S16** «Verificar sus permisos efectivos.» (proyecto anterior)
- **S17** «Renombrar un archivo de entorno solo cambia la configuración local.»
- **S18** «Mantener protegida la copia que contiene datos reales.»
- **S19** «Si un token vigente de Twilio pudo quedar expuesto → priorizar su rotación.»
- **S20** «Evaluar service_role por separado según los indicios de exposición de esa clave.»
- **S21** «Con estos controles en verde, continuar con la recepción de WhatsApp.»

## Tasks

| ID | S# | Ruta | Estado | Evidencia |
|---|---|---|---|---|
| T1 | S1, S2, S3 | inline + delegado (web) | hecho | `append_outbound_message` valida titular y guarda en la misma transacción; 409 `assignment_changed`; la SPA avisa, conserva el borrador y recarga |
| T2 | S4, S5, S6, S7, S8 | inline | hecho | `reassign_conversation` (motivo + versión + auditoría en una transacción) + `conversation_audit_log` append-only; A→B y A→cola probados; dos peticiones con la misma versión → 1 cambio y 1 evento |
| T3 | S9–S13 | inline | hecho | autorización por pertenencia en listado/lectura/descarga/borrado; URL firmada; borrado de fila **y** objeto; policies de Storage para `authenticated` eliminadas |
| T4 | S14, S15 | inline | hecho | suite de aceptación real (19 controles) + `count-access-controls.mjs` falla ante omisión + `--strict` falla ante PENDIENTE + `E2E_CONTROLS_REQUIRED=1` |
| T5 | S16–S20 | inline | hecho | `docs/permisos-y-credenciales-proyecto-anterior.md`: permisos efectivos, copia aislada por red y con `.env` en 600, evaluación separada de Twilio y `service_role` |
| T6 | S21 | inline | hecho | resumen de la etapa siguiente (recepción de WhatsApp) en la entrega |

## Log

- **L1** (2026-11-27) Objetivo del usuario: «OBJETIVO ← cerrar los controles de acceso que faltan y conservar el entorno reconstruido.» Correcciones a PR #1 (diagnóstico, respaldo, permisos de funciones) y PR #2 (autorización de conversaciones y adjuntos).
- **L2** (2026-11-27) **Mapa de los huecos** (exploración del repo): `POST /api/conversations/[id]/messages` exige el permiso `conversation.assign` pero **nunca** carga la conversación ni compara `assigned_agent_id`: `canAccessConversation` existe en el servicio y no se invoca → un agente con el permiso escribe en un chat ajeno (201). `reassignConversation` ignora `actorId`, no exige motivo, no versiona y no audita. Los adjuntos no comprueban pertenencia del ticket ni visibilidad de la conversación origen, pese a que el encabezado del servicio promete lo contrario. `conversations` no tiene `updated_at` ni versión; `tickets.updated_at` sí tiene trigger.
- **L3** (2026-11-27) **Reglas decididas** (para que los controles tengan un criterio verificable):
  - *Escritura de mensajes*: permiso `conversation.assign` **y** ser el titular vigente del chat. Excepción para `admin`/`supervisor` leída del perfil dentro de la función SQL (nunca del cuerpo de la petición).
  - *Transferencias*: permiso `conversation.reassign`, `reason` obligatorio, `expected_version` obligatorio. Auditadas en `conversation_audit_log` (append-only) en la **misma** transacción que el cambio.
  - *Adjuntos*: acceso si el actor es el titular del ticket, o el titular de un chat del que provenga el mensaje, o `admin`/`supervisor`. El objeto de Storage solo se sirve por URL firmada emitida tras la autorización; el borrado elimina la fila y el objeto.
- **L4** (2026-11-27) **Implementado el backend**: migración `20251029000000_conversation_and_attachment_authorization.sql` (versión de asignación, `conversation_audit_log` append-only, `reassign_conversation`, `append_outbound_message`, `take_conversation`, y retiro de las políticas de Storage para `authenticated`), el servicio de conversaciones con mapeo de SQLSTATE → código HTTP, y las rutas con el cuerpo nuevo `{ assigned_agent_id, reason, expected_version }`.
- **L5** (2026-11-27) **Dos ambigüedades de PL/pgSQL que costaron una vuelta**: las columnas de salida de una función chocan con las columnas de la tabla cuando se escriben sin calificar (`assignment_version`, `id`). Se resolvió calificando con alias (`update public.conversations c set ... c.assignment_version + 1`). Sin calificar, la migración falla en tiempo de ejecución con «column reference is ambiguous».
- **L6** (2026-11-27) **Interfaz** (delegado a un worker, superficie `apps/web/**`): la transferencia pide motivo, envía la versión y distingue los 409 (`version_conflict` y `assignment_changed`); el aviso de cambio de titular conserva el borrador y recarga el chat. 4 pruebas nuevas (RED→GREEN) y 41 en total.
- **L7** (2026-11-27) **Suite de aceptación**: `apps/api/integration/conversation-authorization.test.ts`, **19 controles** contra la base real (mensajes 4, transferencias 7, adjuntos 8). Verde contra el stack local (28/28 contando E1) y **repetible** (dos corridas seguidas).
- **L8** (2026-11-27) **Puerta de CI**: `E2E_CONTROLS_REQUIRED=1` hace que la suite **falle** en vez de omitirse si falta el entorno; `scripts/ci/count-access-controls.mjs` falla si la suite no aparece, si hay casos omitidos o si se ejecutan menos de 19; `validate-access-controls.ts --strict` sale con 1 si algún control queda PENDIENTE. Comprobado: con la suite omitida la puerta falla (exit 1).
- **L9** (2026-11-27) **Validador de controles actualizado** al contrato nuevo (motivo + versión + `conversation_audit_log`): **6 OK, 0 PENDIENTE**. El caso B3 usaba como «ajeno» a un agente que podía ser el titular del ticket sembrado; ahora usa una cuenta propia sin ningún ticket ni chat.
- **L10** (2026-11-27) **Proyecto anterior y credenciales**: los permisos efectivos del proyecto anterior son tablas cerradas pero **9 de 9 funciones de la app ejecutables por `PUBLIC`** (`resolve_permissions` es SECURITY DEFINER: el keyring de cualquier perfil es legible por cualquiera) y **3 políticas de Storage** que permiten a cualquier autenticado leer y borrar adjuntos → le faltan las migraciones de E1 y las de este PR. La copia con datos reales quedó en **red propia** (sin puertos publicados) y los `.env` en **600**. En el historial de git (31 commits) **no hay ninguna credencial**: ni `service_role`, ni la `DATABASE_URL` de superusuario. No hay token de Twilio vigente ni en el entorno ni en la base (columnas `twilio_*` vacías) → su rotación **no** está indicada por la evidencia; la del `service_role` sí, cuando el proyecto alojado vuelva a usarse.

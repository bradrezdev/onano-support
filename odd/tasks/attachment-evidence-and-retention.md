# Feature: Evidencia de adjuntos aislada por chat, retención y re-autorización

Objetivo: que cada adjunto se proteja **por chat**, que desvincular nunca destruya un archivo que otro ticket todavía referencia, y que una descarga vuelva a comprobar la autorización del agente.
Rama: `feature/conversation-authorization` (se rebasa sobre `main` al fusionarse el PR #1) · PR: https://github.com/bradrezdev/onano-support/pull/2
Entrega: commits por unidad de trabajo en la rama; CI verde y revisión final validada **antes** de fusionar.
Runner: `pnpm --filter @crm/api test` + suite de aceptación real `apps/api/integration/conversation-authorization.test.ts` (API viva en `:3000`, JWT sintéticos).

## Specs

S1 · "un ticket contiene evidencia de dos chats distintos. El titular del ticket conserva la evidencia que le corresponde."
S2 · "Quien solo atiende uno de los chats ve únicamente la evidencia de ese chat."
S3 · "Aplicar la misma regla al listado, la vista previa y la descarga."
S4 · "un mismo archivo está vinculado a dos tickets. Al desvincularlo del primero, el segundo ticket y el mensaje original siguen abriendo el archivo."
S5 · "Reservar el borrado físico para una operación autorizada que compruebe las referencias y la política de conservación."
S6 · "un agente pierde todo permiso sobre el recurso. La siguiente descarga debe volver a comprobar su autorización."
S7 · "La interfaz retira el historial y aísla el borrador por agente y chat."
S8 · "Al abrir otro cliente, ese borrador nunca aparece en su conversación."
S9 · (derivada de S1-S3) La visibilidad se decide **por adjunto**, no por ticket: un adjunto es visible si el actor es `admin`/`supervisor`, o el titular del ticket (`tickets.assigned_to`), o el titular del chat del mensaje de ese adjunto (`conversations.assigned_agent_id`). El listado filtra fila por fila.
S10 · (derivada de S6) La descarga la sirve la API después de re-comprobar la autorización **en cada petición**; el navegador deja de recibir una URL firmada que sobrevive 5 minutos a la pérdida de permiso.
S11 · (derivada de S4/S5) Desvincular (borrar el vínculo `ticket_message_attachments`) **nunca** borra el objeto de Storage. El borrado físico es una operación aparte, autorizada, que comprueba que no queda ninguna referencia (ni vínculo de ticket, ni `messages.media_urls` con esa ruta) y que se respeta la ventana de conservación configurada; deja bitácora fuera de la base.
S12 · (derivada de S7/S8) El borrador del mensaje se guarda en el navegador con clave **(agente, chat)**: al cambiar de chat o de agente el borrador anterior no aparece; al perder el acceso (403) la interfaz retira el historial cacheado de ese chat.

## Tasks

T1 · Visibilidad por adjunto en el listado (`GET /api/tickets/:id/attachments`): filtrar fila por fila con la regla de S9 — ruta: delegada.
T2 · Descarga y vista previa re-autorizadas: la API sirve los bytes tras comprobar permiso en cada petición; se retira la URL firmada del contrato — ruta: delegada.
T3 · Retención: `DELETE` del vínculo no borra el objeto; operación de purga autorizada (referencias + ventana de conservación + bitácora) — ruta: delegada.
T4 · Pruebas de aceptación contra base real de los tres casos (evidencia de dos chats; archivo en dos tickets; pérdida de permiso y descarga posterior) — ruta: delegada.
T5 · Interfaz: listado, vista previa y descarga con la misma regla; limpieza del historial al 403; borrador aislado por (agente, chat) — ruta: delegada.
T6 · Puertas: el conteo de controles de CI sube para incluir los casos nuevos; documentación del contrato — ruta: delegada.

## Log

L1 (2026-11-27) — Encargo del usuario, textual:

> PR #2 · PROTEGER CADA ADJUNTO Y CONSERVAR EL ORIGINAL
>   Caso de aceptación → un ticket contiene evidencia de dos chats distintos.
>     El titular del ticket conserva la evidencia que le corresponde.
>     Quien solo atiende uno de los chats ve únicamente la evidencia de ese chat.
>     Aplicar la misma regla al listado, la vista previa y la descarga.
>
>   Caso de aceptación → un mismo archivo está vinculado a dos tickets.
>     Al desvincularlo del primero, el segundo ticket y el mensaje original
>     siguen abriendo el archivo. Reservar el borrado físico para una operación
>     autorizada que compruebe las referencias y la política de conservación.
>
>   Caso de aceptación → un agente pierde todo permiso sobre el recurso.
>     La siguiente descarga debe volver a comprobar su autorización.
>     La interfaz retira el historial y aísla el borrador por agente y chat.
>     Al abrir otro cliente, ese borrador nunca aparece en su conversación.

L2 (2026-11-27) — Mapa de hoy (lectura, sin cambios): la autorización se decide **una vez, a nivel de ticket** (`canAccessTicketAttachments`, `message-attachments.ts:115-160`: privileged, o `tickets.assigned_to`, o titular de *cualquier* chat del que venga un adjunto) y el listado devuelve **todas** las filas de `ticket_message_attachments` sin filtrar por chat (`:184-191`) → quien atiende solo un chat ve la evidencia del otro. `GET .../attachments/:messageId` emite una **URL firmada de 300 s** (`:426-428`) y devuelve JSON; el navegador la consume sin volver a pasar por la API → una URL ya emitida sobrevive a la pérdida de permiso. `DELETE` quita el vínculo y **borra el objeto en Storage sin condiciones** (`:357-361`) → si el mismo `attachments/…` está en el `media_urls` de otro mensaje, ese ticket y ese mensaje quedan rotos. En la interfaz **no existe** vista previa ni descarga (solo el listado de texto en `TicketDetailPage.tsx:424-446`) y el borrador vive en estado de React (`ConversationDetailPage.tsx:44`), sin clave por agente ni por chat.

L3 (2026-11-27) — Esquema relevante: `ticket_message_attachments(ticket_id, message_id)` con PK compuesta → un mismo mensaje puede estar en varios tickets y un ticket puede reunir mensajes de varios chats; `messages.media_urls` es un JSONB de rutas **sin unicidad** (la misma ruta puede vivir en varios mensajes); el titular del ticket es `tickets.assigned_to`; el del chat es `conversations.assigned_agent_id`.

L4 (2026-11-27) — Decisiones: (a) la regla de visibilidad es **por adjunto** y el listado filtra fila por fila; (b) la descarga la sirve la API (bytes) en vez de una URL firmada, porque el requisito es que "la siguiente descarga vuelva a comprobar la autorización" y una URL firmada de 5 minutos no lo cumple; (c) desvincular nunca borra el objeto; el borrado físico pasa a una operación autorizada que comprueba referencias y ventana de conservación. *Supuesto declarado:* la ventana de conservación es configurable (`RETENTION_DAYS`, por defecto 30 días) y debe confirmarla el operador — no se inventa una política de negocio fija.

L5 (2026-11-27) — Riesgo de la unidad: item 2 (seguridad) e item 3 (contrato de la API: el tipo de respuesta de la descarga cambia de JSON con `media_url` a bytes). La verificación de esta unidad es el verificador independiente.

# Feature: Recepción de WhatsApp (E3) — entrega única, acuse honesto y firma verificada

Objetivo: que el webhook entrante **no descarte** al contacto desconocido, **no ackee** un error de almacenamiento, valide la firma con el SDK de Twilio contra la URL pública exacta, y sea idempotente por `MessageSid`.
Rama: `feature/whatsapp-inbound-reception` (desde `main`) · PR: pendiente de abrir.
Entrega: commits por unidad de trabajo; CI verde. La fusión la decide el operador.
Runner: `pnpm --filter @crm/api test` + suite de aceptación real `apps/api/integration/whatsapp-inbound.test.ts` (API viva en `:3000`).

## Specs

S1 · "Corregir el webhook actual: hoy descarta al contacto desconocido y también responde con éxito ante errores de almacenamiento."
S2 · "Validar la firma con el SDK de Twilio y la URL pública exacta."
S3 · "Si falta la credencial o la firma es inválida → rechazar antes de escribir."
S4 · "Primer mensaje válido → crear el contacto y dejar el chat visible en la cola."
S5 · "Contacto existente → reutilizar su hilo del mismo canal, incluso al reabrirlo."
S6 · "MessageSid repetido → conservar un mensaje y un solo incremento de no leídos."
S7 · "Confirmar a Twilio con TwiML vacío solo tras guardar la recepción o comprobar que ya estaba guardada."
S8 · "Ante un fallo temporal → devolver un error y verificar la política de reintentos prevista para el piloto."
S9 · "Probar dos entregas simultáneas del mismo mensaje, dos mensajes distintos de un cliente nuevo, un hilo cerrado y una caída de base seguida de reintento."
S10 · (derivada de S2) La URL que se valida es la **pública y exacta** con la que llamó Twilio (`WEBHOOK_BASE_URL` + ruta + query string), no `request.url` de Next: detrás de un proxy el esquema/host/puerto difieren y hoy toda petición legítima se rechaza con 403.
S11 · (derivada de S3) Sin `TWILIO_AUTH_TOKEN` el webhook responde **503** (configuración ausente) y **no escribe nada**; con firma inválida responde **403** y **no escribe nada**. Nunca se "omite" la validación.
S12 · (derivada de S4/S5) El canal es una dimensión explícita (`conversations.channel`), así que "el hilo del mismo canal" es una regla verificable; un hilo cerrado se **reabre y se reutiliza** (mismo `conversation_id`, `status` → `open`), no se crea uno nuevo.
S13 · (derivada de S6/S9) La aceptación es una operación **atómica y serializada** (bloqueo de aviso por contacto dentro de la transacción): dos entregas simultáneas del mismo `MessageSid` dejan **un** mensaje, **un** hilo y **un** incremento de no leídos.
S14 · (derivada de S7) La respuesta de éxito es **TwiML vacío** (`<?xml version="1.0" encoding="UTF-8"?><Response></Response>`) y solo se emite después de que la recepción está guardada o se comprobó que ya lo estaba; si se detecta un duplicado, se responde igual con TwiML vacío (Twilio no debe reintentar un evento ya procesado).
S15 · (derivada de S8) Un fallo temporal de almacenamiento responde **5xx** (no 200). *Política de reintentos del piloto, verificada en la documentación de Twilio:* por defecto Twilio reintenta **una** vez y solo ante fallo de conexión (`rc=1`, `rp=ct`); **un 5xx no se reintenta** salvo que la URL del webhook se configure con overrides de conexión (`#rc=3&rp=5xx,ct,rt`) o con la Webhooks configuration API. Los overrides viajan en el **fragmento** de la URL, que **no** entra en el cálculo de la firma: la validación debe omitirlo.

## Tasks

T1 · Migración + RPC de aceptación entrante: columna `conversations.channel`, bloqueo de aviso por contacto, creación de contacto si no existe, reutilización/reapertura del hilo del canal, inserción idempotente por `twilio_sid`, un solo incremento de no leídos — ruta: delegada.
T2 · Webhook: firma con el SDK de Twilio (`twilio.validateRequest`) contra la URL pública exacta; 503 sin credencial y 403 con firma inválida, sin escribir; dependencia `twilio` — ruta: delegada.
T3 · Respuesta: TwiML vacío tras guardar; 5xx ante fallo temporal; política de reintentos documentada — ruta: delegada.
T4 · Pruebas de aceptación: dos entregas simultáneas del mismo mensaje, dos mensajes distintos de un cliente nuevo, hilo cerrado, caída de base seguida de reintento — ruta: delegada.
T5 · Puertas de CI y documentación (AGENTS.md, README) — ruta: delegada.

## Log

L1 (2026-11-27) — Encargo del usuario, textual:

> E3 · RECEPCIÓN DE WHATSAPP
>   Corregir el webhook actual: hoy descarta al contacto desconocido y también responde con éxito ante errores de almacenamiento.
>   Validar la firma con el SDK de Twilio y la URL pública exacta. Si falta la credencial o la firma es inválida → rechazar antes de escribir.
>
>   Primer mensaje válido → crear el contacto y dejar el chat visible en la cola.
>   Contacto existente → reutilizar su hilo del mismo canal, incluso al reabrirlo.
>   MessageSid repetido → conservar un mensaje y un solo incremento de no leídos.
>   Confirmar a Twilio con TwiML vacío solo tras guardar la recepción o comprobar
>   que ya estaba guardada. Ante un fallo temporal → devolver un error y verificar
>   la política de reintentos prevista para el piloto.
>
>   Probar dos entregas simultáneas del mismo mensaje, dos mensajes distintos de
>   un cliente nuevo, un hilo cerrado y una caída de base seguida de reintento.

L2 (2026-11-27) — Mapa de hoy (lectura, sin cambios): `POST /api/webhooks/twilio` valida contra `request.url` (`:27`, `:38`) con un HMAC-SHA1 escrito a mano (`src/lib/twilio-signature.ts:32`, concatenación ingenua sin la semántica de percent-encoding de Twilio); **sin `TWILIO_AUTH_TOKEN` la validación se omite** (`twilio-signature.ts:25-28`); el contacto desconocido se descarta con `200 { skipped: 'unknown_contact' }` (`:53-56`); **cualquier error de almacenamiento responde 200** con `{ ok: true, error }` (`:65-70`) → Twilio nunca reintenta y el mensaje se pierde; la respuesta de éxito es JSON, no TwiML. El SDK `twilio` **no** es dependencia. `messages.twilio_sid` es UNIQUE y el upsert usa `ignoreDuplicates` (`:220-231`), así que el mensaje no se duplica y el trigger de no leídos no se dispara otra vez — pero `findOrCreateConversationForContact` (`:171-192`) no tiene guarda de unicidad: dos entregas simultáneas pueden crear **dos** conversaciones. No hay columna de canal: el hilo se busca por `contact_id` (el más antiguo) y un hilo `closed` se reutiliza tal cual, sin reabrir ni auditar. La cola es el conjunto **sin titular** (`assigned_agent_id is null`), y el disparador `bump_conversation_on_message` sube `unread_count` solo en entradas con `direction='in'`.

L3 (2026-11-27) — Política de reintentos, verificada en la documentación de Twilio (`https://www.twilio.com/docs/usage/webhooks/webhooks-connection-overrides`, fecha de la página 2026-10-14): valores por defecto `rc=1` (un reintento) y `rp=ct` (solo fallo de conexión/TLS) → **un 5xx no se reintenta**; para reintentar ante 5xx hay que configurar la URL con `#rc=3&rp=5xx,ct,rt` (o la Webhooks configuration API, que Twilio recomienda). Los overrides van en el **fragmento**, y el fragmento **no** forma parte de la firma. Consecuencia para el piloto: responder 5xx es correcto y necesario, pero **el reintento solo existe si la URL del webhook en la consola de Twilio lleva los overrides**: queda documentado como requisito de configuración, no como código.

L4 (2026-11-27) — Decisiones: (a) la aceptación se resuelve en una función `security definer` del repo con bloqueo de aviso por contacto, para que el "crear contacto + reutilizar/reabrir hilo + insertar mensaje" sea una sola transacción serializada y el `unread_count` no se incremente dos veces; (b) se agrega `conversations.channel` con valor por defecto `whatsapp` para que "el hilo del mismo canal" sea verificable; (c) sin credencial → 503, firma inválida → 403, y en ninguno de los dos casos se escribe; (d) TwiML vacío como acuse.

L5 (2026-11-27) — Riesgo de la unidad: item 2 (seguridad: la firma decide si se acepta una entrada externa) e item 6 (una caída de base con reintento no puede duplicar mensajes). La verificación de esta unidad es el verificador independiente.

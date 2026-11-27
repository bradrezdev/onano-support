# E1 · Protección de perfiles y puerta de datos real

Objetivo: cerrar la autoedición de privilegios sobre el perfil (E1-C) y reemplazar el job E2E simulado por pruebas autenticadas contra una instancia efímera de Supabase con datos sintéticos (E1-B), de modo que el CI detecte un fallo controlado y demuestre quién puede cambiar cada campo protegido.
Rama: `feature/e1-profile-protection` (base `feature/e0-verificacion-reproducible` @ `64ca6af`).
Entrega: work-unit commits sobre la rama de feature; push y PR al final.
Test runner: `pnpm test` (vitest, api+web) · `pnpm --filter @crm/web test:e2e` (Playwright) · suite E1 de integración real en CI (instancia efímera).

## Specs

- **S1** «DIAGNOSTICAR LA BASE COMPARTIDA EN MODO LECTURA. Confirmar proyecto, rama de Supabase, base y rol de conexión. Contrastar las tablas visibles con el inventario administrativo. Revisar eventos de mantenimiento o restauración y respaldos disponibles. SI el esquema sigue sin aparecer → entregar evidencia fechada, último respaldo conocido y opciones de recuperación. SI la causa sigue incierta → declararla desconocida. Reservar cualquier escritura o restauración en esa base para aprobación aparte.»
- **S2** «Preservar el código de salida de pruebas, lint y Playwright al guardar sus logs.»
- **S3** «DEMOSTRAR → un fallo controlado deja rojo el paso correspondiente.»
- **S4** «Preferir una instancia efímera de Supabase con usuarios y datos sintéticos.»
- **S5** «ANTES de migrar → verificar el destino aislado y la configuración completa.»
- **S6** «Usar esa misma validación para migrar, arrancar la API y ejecutar las E2E.»
- **S7** «SI la API no logra leer un dato de prueba dentro del plazo → fallar el job.»
- **S8** «SI se ejecutan cero pruebas autenticadas → marcar E1 como pendiente.»
- **S9** «Revisar el ejecutor de migraciones. CASO → una migración revierte tras encontrar un objeto duplicado. RESULTADO ESPERADO → queda pendiente y el proceso comunica el error. El texto «already exists» por sí solo no acredita que la migración se completó.»
- **S10** «Inventariar qué campos del perfil necesita editar cada actor y por qué vía. Reservar rol, permisos y suspensión al flujo administrativo autorizado.»
- **S11** «Validar los permisos efectivos tanto en la API como en el acceso directo a los datos.»
- **S12** «ACEPTACIÓN CON USUARIOS SINTÉTICOS: Agente edita un campo personal permitido → el cambio persiste. Agente carece de permiso sobre campos administrativos → esos campos conservan su valor. Administrador autorizado cambia un rol → el cambio persiste y queda auditado.»
- **S13** «CREDENCIALES → documentar solo metadatos. SI hay indicios razonables de exposición del token de Twilio → priorizar contención y rotación de ese token. Evaluar la clave service_role de Supabase según su propia evidencia de exposición.»
- **S14** «ENTREGA ← commit, enlace al CI, pruebas realmente ejecutadas y pendientes. CRITERIO DE CIERRE ← el CI detecta un fallo controlado y las pruebas autenticadas demuestran quién puede cambiar cada campo protegido.»

## Tasks

| ID | S# | Ruta | Estado | Commit |
|---|---|---|---|---|
| T1 | S1 | delegado (explorador, solo lectura) | hecho | — (engram obs 1221) |
| T2 | S1, S13 | inline | hecho | E1 |
| T3 | S10, S13 | inline | hecho | E1 |
| T4 | S9 | inline | hecho | E1 |
| T5 | S4, S5, S6 | inline | hecho | E1 |
| T6 | S2, S3, S7, S8 | inline | hecho | E1 |
| T7 | S11, S12 | inline | hecho | E1 |
| T8 | S14 | inline | en curso | E1 |

## Log

- **L1** (2026-11-27) «OBJETIVO ← cerrar la verificación de E0 e iniciar E1 por la protección de perfiles. BASE ← feature/e0-verificacion-reproducible, commit 64ca6af. ALCANCE ← mantener T1 en su rama. Trabajar con datos sintéticos para E1. EN PARALELO A. DIAGNOSTICAR LA BASE COMPARTIDA EN MODO LECTURA… B. CORREGIR E0 Y PREPARAR PRUEBAS AISLADAS… CUANDO B ESTÉ LISTO → INICIAR C, AUNQUE A SIGA EN INVESTIGACIÓN C. CERRAR LA AUTOEDICIÓN DE PRIVILEGIOS… ENTREGA ← commit, enlace al CI, pruebas realmente ejecutadas y pendientes. CRITERIO DE CIERRE ← el CI detecta un fallo controlado y las pruebas autenticadas demuestran quién puede cambiar cada campo protegido.»
- **L2** (2026-11-27) T1 cerrado: el esquema `public` del proyecto `nlhfnryxvpzqynvyiduw` fue **eliminado** sobre un proyecto **no nuevo** (`auth` 27 tablas, extensiones `pgcrypto`/`pg_trgm` y 2 secretos de `vault` sobreviven; GoTrue vivo → no está pausado). El ledger `public.schema_migrations` desapareció con el resto. El detonante (quién y cuándo) queda **desconocido**: no hay acceso a logs de Postgres ni a metadatos de respaldos desde este entorno. La página que los muestra es `https://supabase.com/dashboard/project/nlhfnryxvpzqynvyiduw/database/backups`. Ninguna escritura ni restauración se ejecuta sobre esa base sin aprobación aparte.
- **L3** (2026-11-27) Decisión de diseño C: el cambio de rol y su bitácora viajan en la **misma transacción** mediante funciones `security definer` (`admin_update_profile`, `admin_replace_role_permissions`); sin eso, un cambio de rol y su rastro son dos llamadas y la segunda puede fallar dejando el rol cambiado sin registrar.
- **L4** (2026-11-27) Decisión de diseño B: la instancia efímera corre **en CI** (el runner tiene Docker; esta máquina no). El stack se levanta desde un directorio temporal con su propio `config.toml` y **sin** `supabase/migrations`, para que la única puerta de esquema sea el ejecutor del repo (`db:migrate`) y su ledger sea el que CI valida.
- **L5** (2026-11-27) La base de datos compartida **no** se toca en E1: la validación de destino aislado debe **rechazarla** (host no local) para que nadie pueda migrar por accidente contra ella.
- **L6** (2026-11-27) La migración `20251028000000_profile_protection_and_audit.sql` revoca **todos** los privilegios de `anon`/`authenticated` sobre `public` (y los `default privileges`, para que las tablas futuras nazcan cerradas) y elimina las columnas `twilio_*` de `profiles`. Justificación de que no rompe la app: el SPA usa la clave publicable **solo** para Auth (`supabase.from(` no aparece en `apps/web/src`) y la API habla siempre con `service_role`.
- **L7** (2026-11-27) `updateUser` y `replacePermissions` dejan de escribir directo y llaman a `admin_update_profile` / `admin_replace_role_permissions`. El cambio y su bitácora viajan en la misma transacción; con dos llamadas, un fallo de la segunda dejaba el rol cambiado sin rastro.
- **L8** (2026-11-27) El job de E2E se rehízo: antes solo arrancaba la API y nunca levantaba el servidor web (con `BASE_URL` seteado, Playwright no lo levanta), así que nunca pudo correr. Ahora levanta una **instancia efímera** de Supabase desde `supabase/ci/config.toml` (copiado a un directorio temporal, sin `migrations`), aplica el ejecutor del repo, siembra datos sintéticos y corre Playwright **autenticado** + la suite E1 de integración real.
- **L9** (2026-11-27) La suite protegida escribe un **testigo** (`E2E_AUTH_MARKER`) solo después de un inicio de sesión real. `scripts/ci/count-authenticated-tests.mjs` falla el job si el testigo no existe: cero pruebas autenticadas ⇒ E1 **PENDIENTE**, no verde.
- **L10** (2026-11-27) E1 entra como **un solo commit**: el código, la puerta de CI y la documentación tienen que moverse juntos (el review GGA rechaza documentación desalineada con el código). Si hace falta foco de revisión, se divide antes del PR, no después.
- **L11** (2026-11-27) Verificación local antes de publicar: typecheck ✓, 345 unit tests de API + 34 de web ✓, lint 0 errores (24 warnings) ✓, build ✓, Playwright local 10 pasan / 8 omitidos ✓.

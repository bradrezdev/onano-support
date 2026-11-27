# Entorno de desarrollo reconstruido (destino nuevo y aislado)

Objetivo: reconstruir el CRM en un destino de desarrollo **persistente, aislado del CI y del proyecto anterior**, con el esquema del repo (incluida la protección de perfiles de E1) y datos sintéticos verificados; y **preservar la posibilidad de recuperar el historial** del proyecto alojado anterior sin escribirle nunca.
Rama: `feature/e1-profile-protection` (misma rama que E1; el PR #1 lleva E0 + E1 + este trabajo).
Entrega: commits sobre la rama de feature; el PR queda listo para revisión.
Test runner: `pnpm test` · `pnpm --filter @crm/api test:integration` · `pnpm --filter @crm/web test:e2e` · `scripts/validate-access-controls.ts`.

## Specs

- **S1** «Crear un destino de desarrollo persistente y aislado del CI y del proyecto anterior.»
- **S2** «Verificar la identidad del destino antes de la primera escritura.»
- **S3** «Aplicar las migraciones versionadas del repo, incluida la protección de perfiles de E1.»
- **S4** «Si falla una migración → detener la secuencia antes de aplicar la siguiente.»
- **S5** «Repetir la ejecución → verificar que queden cero migraciones pendientes y cero duplicados.»
- **S6** «Usar datos sintéticos para comprobar que la API y la interfaz funcionan juntas.»
- **S7** «Mantener el proyecto anterior en modo de consulta durante esta tarea. Inventariar cuentas, tablas y archivos que aún existan, sin registrar secretos.»
- **S8** «Si falta acceso al panel de respaldos → declarar "respaldos pendientes de verificar" y continuar la reconstrucción.»
- **S9** «Si aparece un respaldo anterior a la pérdida → restaurarlo en una copia privada separada → cotejar contactos, chats, mensajes y asignaciones → verificar que una muestra de adjuntos realmente se pueda abrir.»
- **S10** «Si solo se recupera la estructura → entregar "CRM reconstruido con historial pendiente de recuperación".»
- **S11** «Cotejar sus identificadores con los perfiles del CRM → crear los perfiles faltantes y asignar únicamente roles confirmados.»
- **S12** «Verificar los permisos efectivos de las funciones administrativas y de resolve_permissions, incluidos los heredados de PUBLIC.»
- **S13** «Dos agentes intentan tomar el mismo chat al mismo tiempo → queda un solo titular.»
- **S14** «Un agente ajeno al chat → carece de acceso al historial y a sus adjuntos.»
- **S15** «Una transferencia autorizada → cambia el titular y registra quién la hizo y por qué.»
- **S16** «Si algún control sigue pendiente → mantener el entorno con datos sintéticos.»
- **S17** «Dejar un respaldo de la nueva base, demostrar que se restaura en otra instancia y registrar los futuros cambios de esquema fuera de la base que protege.»

## Tasks

| ID | S# | Ruta | Estado | Evidencia |
|---|---|---|---|---|
| T1 | S1, S2 | inline | hecho | stack local `~/supabase-dev/onano-support-dev` (colima + Docker); `assert-isolated-target.ts` OK antes de escribir |
| T2 | S3, S4, S5 | inline | hecho | 22 migraciones aplicadas; 22 distintas; 0 pendientes; 0 duplicados; segunda pasada = solo `skip` |
| T3 | S6 | inline | hecho | suite E1 7/7 y Playwright 18/18 contra el destino nuevo (API + web juntos) |
| T4 | S7, S8 | inline (delegado antes) | hecho | proyecto anterior: 25 tablas en `public`, 2 cuentas, 1 bucket, 0 objetos; **sin acceso al panel de respaldos** |
| T5 | S9, S10 | inline | hecho | copia privada `crm_legacy_copy` con el historial recuperable; **sin adjuntos que abrir** |
| T6 | S11, S12 | inline | hecho | perfiles cotejados por id; permisos efectivos verificados (0 funciones propias ejecutables por PUBLIC) |
| T7 | S13, S14, S15, S16 | inline | hecho | validador: **3 OK, 3 PENDIENTE** → el entorno sigue sintético |
| T8 | S17 | inline | hecho | volcado + restauración verificada en otra instancia (conteos idénticos) |

## Log

- **L1** (2026-11-27) «DECISIÓN ← Sí, reconstruir el CRM en un entorno de desarrollo nuevo y aislado. Conservar el proyecto actual como fuente de recuperación. La reconstrucción puede empezar aunque la autoría siga siendo desconocida.»
- **L2** (2026-11-27) El proyecto anterior **volvió**: su `public` pasó de 0 a 25 tablas. No fue una eliminación: la plataforma lo **restauró por PITR a 2026-10-26** (el ledger conserva 21 migraciones con `applied_at` de esa fecha). Mi probe de las 21:40 UTC lo vio vacío porque cayó en medio de la restauración. **La autoría sigue siendo desconocida**, pero la causa ya no es «se borró»: fue una restauración.
- **L3** (2026-11-27) Contenido recuperado en el proyecto anterior: 2 cuentas (1 admin + 1 soporte), 3 clientes, 3 tickets, **0 conversaciones, 0 mensajes, 0 adjuntos** (1 bucket vacío). El historial de chats **no** existe: no hay nada que cotejar ni adjuntos que abrir.
- **L4** (2026-11-27) **Sin acceso al panel de respaldos** (no hay `SUPABASE_ACCESS_TOKEN` ni CLI vinculado): estado = «respaldos pendientes de verificar». La copia privada del historial recuperable se obtiene del propio proyecto restaurado, no de un respaldo.
- **L5** (2026-11-27) El destino de desarrollo es el **stack local** de Supabase CLI sobre colima: persistente (volumen Docker), aislado del CI y del proyecto anterior. Sin Docker, `colima start --cpu 2 --memory 4 --disk 30` (la máquina es arm64 con virtualización por hardware).
- **L6** (2026-11-27) El ejecutor de migraciones ahora **detiene la secuencia** en la primera migración que revierte (antes seguía con la siguiente). Consecuencia: una migración rota no deja el esquema a medias.
- **L7** (2026-11-27) **Hueco encontrado al verificar los permisos heredados de PUBLIC**: `resolve_permissions` es SECURITY DEFINER y nace con EXECUTE para PUBLIC; la migración de E1 le quitó el privilegio a `anon` y `authenticated`, pero revocar roles concretos no quita el permiso por defecto de PUBLIC. anyone podía pedir el keyring de cualquier perfil. Corregido con la migración `20251028000100` (revoca PUBLIC de las funciones propias de la app y deja el diagnóstico `app_functions_executable_by_public()`).
- **L8** (2026-11-27) Veredicto de los controles: **la toma simultánea funciona** (un solo ganador, el otro 409) y **el detalle de una conversación ajena se filtra** (403 ✓). Pendientes: un agente ajeno **puede escribir** en un chat que no es suyo (201), los **adjuntos no se filtran** (200) y la **transferencia no queda registrada** (no hay bitácora de conversaciones ni campo de motivo). Por S16, el entorno **sigue con datos sintéticos**.
- **L9** (2026-11-27) Respaldo y restauración: el volcado del esquema `public` vive FUERA de la base (`~/supabase-dev/backups/`) y se restauró en **otra instancia** (un `postgres:15` limpio) con conteos idénticos. El esquema que protege a la base sigue siendo el repo (`supabase/migrations/`), no el ledger de la base.
- **L10** (2026-11-27) Defecto de aplicación encontrado por la prueba de navegador: el perfil que llega por `/api/me` **borraba lo que el usuario ya había escrito** en su perfil (el guardado persistía el nombre viejo diciendo «Perfil guardado»). Corregido con una guarda `dirty` + prueba de regresión (RED→GREEN) en `apps/web/src/pages/ProfilePage.test.tsx`.

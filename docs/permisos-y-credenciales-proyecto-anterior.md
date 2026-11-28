# Permisos efectivos y credenciales: proyecto anterior y entorno de desarrollo

Fecha del análisis: **2026-11-27**. Todo lo de aquí es de lectura: al proyecto anterior **no se le escribe nunca**.

## 1 · Permisos efectivos del proyecto anterior (el que quedó en consulta)

Medido sobre el proyecto alojado (`apps/api/.env.legacy`), con la clave `service_role`, solo lectura:

| Superficie | Estado | Evidencia |
|---|---|---|
| Tablas de `public` para `anon` y `authenticated` | **Cerrada** | 0 tablas con `SELECT` para `anon`, 0 para `authenticated` |
| Políticas RLS en `public` | **Siguen existiendo** (22) | incluye `profiles self update` (UPDATE) y `profiles admin manage` (ALL) |
| Funciones propias de la app ejecutables por `PUBLIC` | **ABIERTAS: 9 de 9** | `resolve_permissions` (SECURITY DEFINER) tiene `=X/postgres` en `proacl` |
| Bucket `whatsapp-media` | privado, pero con **3 políticas de Storage** | `whatsapp-media authed upload/read/delete` → cualquier autenticado lee o borra adjuntos |
| `profiles.twilio_*` | columnas presentes, **0 filas con valores** | el token nunca se guardó por usuario |

Dos consecuencias que hay que entender bien:

1. **Lo que protege es el `GRANT`, no la política.** Las políticas `profiles self update` y `profiles admin manage` siguen ahí: si alguien vuelve a conceder `UPDATE` sobre `profiles` a `authenticated`, el hueco de autoedición de privilegios (E1) vuelve a abrirse solo. Por eso E1 revoca **y** borra las políticas.
2. **`resolve_permissions` ejecutable por `PUBLIC` es un agujero vivo en ese proyecto**: es `SECURITY DEFINER` y resuelve el keyring de **cualquier** perfil, así que hasta `anon` sin sesión puede pedirlo. Se cierra con las migraciones de E1 (`20251028000000` y `20251028000100`), que ese proyecto todavía **no** tiene aplicadas (su ledger llega a 21 migraciones, la última del 2026-10-26).

**Estado:** el proyecto anterior tiene cerrados los privilegios de tabla, pero **le faltan las migraciones de E1** (funciones por PUBLIC, bitácora, columnas `twilio_*`) **y las de PR #2** (políticas de Storage, autorización de conversaciones y adjuntos). Se aplican cuando ese proyecto vuelva a estar en uso.

## 2 · La copia con datos reales

La copia privada del historial recuperable (`crm_legacy_copy`) contiene lo que sobrevivió: **2 perfiles, 3 clientes, 3 tickets, 0 conversaciones, 0 mensajes, 0 adjuntos**.

Cómo está protegida:

| Medida | Estado |
|---|---|
| Puertos publicados al host | **ninguno** (`PortBindings` vacío): no se alcanza desde la red |
| Red | **propia** (`crm_legacy_copy_net`): no comparte red con el stack de desarrollo ni con ningún otro contenedor |
| `pg_hba.conf` | `trust` solo para socket local y loopback; **scram-sha-256** para cualquier otra conexión |
| Volumen | `crm_legacy_copy_data`, dedicado a esta copia |
| Permisos de los `.env` que la describen | `600` (antes `644`: cualquier usuario de la máquina podía leerlos) |

## 3 · Credenciales: evaluación por separado

### Twilio

| Pregunta | Respuesta con evidencia |
|---|---|
| ¿Hay un token vigente en el entorno? | **No**: `TWILIO_AUTH_TOKEN` está **vacío** en `apps/api/.env` y en `apps/api/.env.legacy` |
| ¿Se guardó alguna vez en la base? | **No**: `profiles` conserva las columnas `twilio_*` pero **0 filas** con valores |
| ¿Entró al repositorio? | **No**: 0 coincidencias del valor de ninguna credencial en los 31 commits del historial |
| ¿Quedó expuesto por una política de base de datos? | Las políticas de `profiles` **exponían las columnas** a cualquier autenticado, pero estaban **vacías**: no había nada que exponer |

**Veredicto:** con la evidencia disponible **no hay un token de Twilio vigente que haya podido quedar expuesto**. La rotación no está indicada por los datos. Si existe un token en la cuenta de Twilio que se usó en el pasado, su rotación es una decisión del operador y no se puede verificar desde este entorno. Lo que sí era real era el **riesgo estructural**: las columnas `twilio_auth_token` vivían en una tabla con política de lectura para cualquier autenticado. E1 las elimina.

### `service_role`

| Pregunta | Respuesta con evidencia |
|---|---|
| ¿Entró al repositorio? | **No**: 0 coincidencias en los 31 commits |
| ¿Se guardó en la base? | **No**: es una clave de la plataforma, no una columna |
| ¿Quién podía leerla en esta máquina? | **Cualquier usuario del equipo**: los `.env` estaban en modo `644`. Corregido a `600` |
| ¿Es la clave que puede saltarse RLS? | **Sí**: con ella se leen y escriben TODAS las tablas, saltándose RLS y los `GRANT` |

**Veredicto:** el `service_role` es **la** credencial crítica de este proyecto (y la `DATABASE_URL` es el superusuario de Postgres, que es aún peor). No hay evidencia de que saliera del equipo, pero hay dos hechos que justifican rotarla cuando el proyecto alojado vuelva a usarse:

1. Ese proyecto sufrió un **PITR** y un vaciado sin autor conocido: el personal de la plataforma tuvo acceso a la base durante ese proceso.
2. La clave convive con una `DATABASE_URL` de superusuario en el mismo archivo, y ese archivo estaba en modo `644` hasta hace un momento.

**Prioridad recomendada:** `service_role` **antes** que el token de Twilio, y solo cuando el proyecto alojado vuelva a estar en uso (mientras tanto no se usa: el entorno de desarrollo apunta al stack local).

## 4 · Lo que NO es una exposición

- **Renombrar un archivo de entorno solo cambia la configuración local.** Mover `apps/api/.env` a `apps/api/.env.legacy` no le hace nada a la base del proyecto anterior: solo cambia qué configuración lee la app en esta máquina. La base se protege con `GRANT`/`REVOKE`, con las políticas de Storage y con el hecho de que al proyecto anterior no se le escribe nunca.
- El `publishable`/`anon` **no** es un secreto: viaja al navegador por diseño. Lo que importa es que no pueda leer nada.

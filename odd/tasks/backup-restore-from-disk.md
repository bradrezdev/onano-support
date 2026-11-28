# Feature: Respaldo restaurable desde disco

Objetivo: demostrar que el respaldo **guardado** sirve — separarlo de su restauración y restaurarlo en un proceso nuevo, con el origen desconectado, solo desde los archivos.
Rama: `feature/e1-profile-protection` · PR: https://github.com/bradrezdev/onano-support/pull/1
Entrega: commits por unidad de trabajo en esta rama; push y CI verdes **antes** de fusionar.
Runner: `pnpm --filter @crm/api test` (vitest, `src/**/*.test.ts`) + los scripts de respaldo de `apps/api/scripts/` (se ejecutan contra el stack local de Supabase).

## Specs

S1 · "Separar la creación del respaldo de su restauración."
S2 · "En un proceso nuevo, con el origen desconectado, recuperar exclusivamente desde los archivos guardados."
S3 · "Verificar identidad, permisos, relación entre cuenta y chat, historial y bytes del adjunto."
S4 · "Si falta o está dañado un archivo necesario → el ensayo falla."
S5 · (derivada de S3) El respaldo debe incluir los objetos del bucket `whatsapp-media`: sin ellos no hay "bytes del adjunto" que recuperar desde disco. *Supuesto declarado:* hoy el volcado cubre solo el esquema `public` y el archivo viaja como base64 dentro del manifiesto.
S6 · (derivada de S4) Cada archivo del respaldo lleva su sha256 en el manifiesto; la restauración verifica tamaño y hash **antes** de usar nada.
S7 · (derivada de S3) La cuenta de la muestra se crea en el destino con las credenciales del manifiesto —los hash de contraseña no se pueden migrar entre instancias—, así que la "identidad" se verifica **iniciando sesión en el destino**.
S8 · (derivada de S2) La restauración no abre ninguna conexión al origen: el ensayo se demuestra con el contenedor del origen **detenido** y el destino sin ninguna referencia al origen.
S9 · (derivada de S1/S3) El ensayo deja el mismo rastro que hoy: destino, actor, fecha, commit y migraciones **fuera de la base** (`~/supabase-dev/backups/registry.jsonl`), ahora también con los archivos del respaldo y sus hashes.

## Tasks

T1 · Script de creación del respaldo: volcado del esquema `public`, **objetos de Storage** y `manifest.json` con sha256, tamaño, commit, fecha, ledger y credenciales de la muestra — `apps/api/scripts/create-backup.ts` — ruta: delegada.
T2 · Verificación de integridad: falla si falta un archivo o si su sha256 no coincide — `apps/api/src/lib/backup-integrity.ts` + test unitario — ruta: delegada.
T3 · Restauración desde disco, sin origen, con verificación completa (identidad, permisos, relación cuenta↔chat, historial, bytes) — `apps/api/scripts/restore-rehearsal.ts` (reescrito) — ruta: delegada.
T4 · Orquestación con origen desconectado: crear respaldo → detener origen → restaurar → verificar → arrancar origen — `scripts/dev/backup-and-verify-restore.sh` — ruta: delegada.
T5 · Job de CI que repite el ciclo completo — `.github/workflows/backup-restore.yml` — ruta: delegada.
T6 · Documentación: qué es un respaldo, cómo se prueba y qué falla — `docs/respaldos.md`, sección de respaldo de `AGENTS.md` y `README.md` — ruta: delegada.

## Log

L1 (2026-11-27) — Encargo del usuario, textual:

> PR #1 · DEMOSTRAR QUE EL RESPALDO GUARDADO SIRVE
>   El ensayo actual genera un volcado, pero reconstruye la muestra con datos que siguen en memoria. Separar la creación del respaldo de su restauración.
>   En un proceso nuevo, con el origen desconectado, recuperar exclusivamente desde los archivos guardados. Verificar identidad, permisos, relación entre cuenta y chat, historial y bytes del adjunto.
>   Si falta o está dañado un archivo necesario → el ensayo falla.

L2 (2026-11-27) — Mapa de lo que hay hoy (lectura, sin cambios): `restore-rehearsal.ts` crea la muestra **en el origen** (`:172-232`), hace el `pg_dump` desde el contenedor del origen (`:238-259`), y verifica contra la copia usando **bytes e ids que ya tiene en memoria** (`:470`, `:461`, `:482`). El volcado y el manifiesto nunca se consumen: no hay verificación de hash en ningún punto del repo (`sha256|checksum|md5` → 0 coincidencias) y el bucket `whatsapp-media` no se respalda. El script `scripts/dev/backup-and-verify-restore.sh` genera un `.dump` que restaura en un `postgres:15` desechable y solo cuenta filas.

L3 (2026-11-27) — Decisión de diseño: el respaldo es **un directorio** (`manifest.json`, `public.sql`, `storage/…`) con un hash por archivo; la restauración consume **solo ese directorio**. El origen se demuestra desconectado **deteniendo su contenedor** (`docker stop`), no simulándolo con variables de entorno: la prueba vale si el origen es inalcanzable de verdad. La creación y la restauración quedan en procesos y scripts separados (`create-backup.ts` / `restore-rehearsal.ts`), orquestados por el shell.

L4 (2026-11-27) — El destino es la instancia de restauración existente (`~/supabase-dev/onano-support-restore`, API 54331 / DB 54332). El esquema se reconstruye con las migraciones del repo (no desde el volcado) y las MUESTRAS se restauran desde los archivos del respaldo.

L5 (2026-11-27) — Riesgo de la unidad: item 1 (datos). El respaldo y la restauración tocan datos reales de una base; un ensayo que declara éxito sin restaurar nada es exactamente el defecto que se está corrigiendo. La verificación de esta unidad es el verificador independiente.

L6 (2026-11-28) — Evidencia observada (ciclo completo, en esta máquina):
- `bash scripts/dev/backup-and-verify-restore.sh` → **exit 0**. El respaldo quedó en `~/supabase-dev/backups/backup-20261128T023232` (esquema `public`, 13 objetos de `whatsapp-media`, `manifest.json` con sha256 por archivo). La restauración se ejecutó **con el origen apagado y su API inaccesible** (`http://127.0.0.1:54321` no responde) y verificó: inicio de sesión, keyring (9 permisos), relación cuenta↔chat↔cliente, historial servido por el route handler real y **60 bytes** del adjunto idénticos a los del archivo en disco. El origen se volvió a levantar con `trap` incluso si la restauración falla.
- Caso negativo A (archivo faltante): `restore-rehearsal.ts --backup` → **exit 1** con `FALLO en integridad: Falta el archivo del respaldo: storage/muestra/e2e-rehearsal.txt`.
- Caso negativo B (archivo dañado): **exit 1** con `Hash sha256 no coincide para public.sql` (esperado `ad715…` vs encontrado `78d21…`).
- `pnpm --filter @crm/api test src/lib/backup-integrity.test.ts` → 3 pruebas verdes. Suite completa: **348 pruebas API** + 37 web, typecheck limpio, lint sin errores.
- Correcciones aplicadas al revisar el trabajo del subagente: la prueba de desconexión pasó a comprobar con `curl` que el origen **no responde** (antes solo miraba nombres de contenedor, que puede pasar en falso si el nombre cambia); el job de CI hace lo mismo; el SQL de la muestra se escribe ahora en un directorio temporal, porque **el directorio del respaldo es la fuente verificada y no se toca**.
- El subagente que escribió la unidad murió por el límite de uso del proveedor antes de entregar su informe: la verificación de arriba la hizo el padre, en línea, con las salidas observadas.

L7 (2026-11-28) — Revisión nativa (lente de resiliencia) sobre el rango `6663e2f..463a4a8`: tres hallazgos. **R4-1 (CRÍTICO)**: el job de CI no sembraba la base ni pasaba el nombre del contenedor del origen (`supabase_db_onano-support-ci`), así que el respaldo fallaba de forma determinista — **ya corregido** en `f77c421` (el CI lo confirmó: el respaldo se creó y el job llegó al paso de detener el origen). **R4-2 (WARNING)**: si el origen aparecía corriendo durante la restauración, el script solo avisaba y seguía: la demostración podía ser falsa y aun así salir en verde → ahora es **fallo** (exit 1). **R4-3 (WARNING)**: un manifiesto corrupto reventaba con `SyntaxError` sin registrar el fallo y dejaba el directorio temporal en `/tmp` → ahora el parseo falla con el mensaje estructurado y el temporal se limpia en cualquier fallo.
- La revisión nativa no pudo completarse: el transporte de los lentes falló con `provider_failed` (modelos de `opencode-go` bloqueados por la región del usuario). El lente de resiliencia sí llegó a ejecutarse y es el que reporto los hallazgos de arriba. Queda una transaccion abierta (`lineage review-df7515efea03eb0f`) sin veredicto: es informacion, no bloquea la entrega, y la fusion la decide el operador.

L8 (2026-11-28) — Revision independiente de la unidad (riesgo, resiliencia y confiabilidad) devuelvio hallazgos; todos corregidos en este mismo commit de trabajo, sin tocar `## Specs`:

- **La demostracion de desconexion podia pasar en falso (BLOQUEANTE)**: el orquestador leia la URL del origen solo de `apps/api/.env`; si esa linea faltaba, el `curl` nunca corria, el script imprimia "Origen desconectado" y salia en 0 **mientras el origen respondia 200**. Ahora la URL se resuelve del entorno primero (`ORIGIN_API="${SUPABASE_URL:-}"`) y luego de `apps/api/.env`; si no se puede resolver, el orquestador **falla** (exit 1). El `curl` es obligatorio: no queda detras de un condicional. Los contenedores del origen se derivan de las mismas perillas que honra `create-backup.ts` (`ORIGIN_DB_CONTAINER`, `ORIGIN_PROJECT`), no de nombres escritos a mano.
- **El volcado estaba hasheado pero nunca se aplicaba**: ahora el manifiesto declara las **filas por tabla** del volcado, sus **extensiones** y los **objetos externos** de los que depende el esquema (`auth.users`, que administra GoTrue y no esta en el respaldo). En la restauracion el volcado se aplica en una **base de datos de prueba** del Postgres de destino (`backup_check`, que se borra siempre, tambien cuando falla) y sus conteos por tabla se comparan con los del manifiesto: si difieren, el ensayo falla. El volcado se genera `--no-privileges`: es un volcado de esquema y datos, y los privilegios los fijan las migraciones del repo, que es su fuente de verdad.
- **Se restauraban archivos que el manifiesto no declaraba**: ahora la verificacion de integridad compara **tamanio y hash**, rechaza un manifiesto sin archivos y falla nombrando cualquier archivo de `storage/` que el manifiesto no declare. La restauracion sube solo lo declarado.
- **La restauracion no podia distinguir un archivo de texto de una imagen**: el manifiesto declara el tipo de contenido de cada objeto (`storage.objects.metadata.mimetype`) y la restauracion lo respeta; si se desconoce, usa `application/octet-stream`.
- **El manifiesto no era un contrato verificado**: hoy hay pruebas deterministas que construyen el manifiesto como lo arma el creador (una entrada por archivo con `path`, `size` y `sha256`, el volcado presente, el adjunto con entrada propia) y comprueban que el consumidor lo acepta; la verificacion de integridad compara tamano y hash, rechaza el manifiesto sin archivos y el que no tiene el arreglo de archivos, y devuelve siempre un fallo estructurado (nunca una excepcion cruda) incluso cuando una entrada apunta a un directorio o a una ruta que se sale del respaldo.
- **Password de muestra en el codigo fuente**: ahora se genera al vuelo en cada respaldo y solo vive en el manifiesto (modo 600). El directorio del respaldo nace en 700 y todos sus archivos en 600.
- **Errores ignorados en el creador**: fallan de forma visible el listado de cuentas, el `UPDATE` de `profiles`, el cliente de muestra y el listado de buckets. El directorio del respaldo lleva marca de tiempo con milisegundos y el creador **se niega a escribir** en un directorio que ya existe.
- **Registro de los ensayos**: `register()` crea el directorio, nunca deja que un error de escritura tape el fallo original (lo avisa por stderr) y deja siempre una linea `resultado: "FALLO"`.
- **`psql` sin puerto (BLOQUEANTE en CI)**: el fallback al `psql` del sistema construia `-h host -U postgres -d postgres` **sin puerto**, asi que en el runner de CI se conectaba al 5432 y fallaba. Ahora el puerto viaja siempre explicito (5432 por omision).
- **Traversal de rutas al guardar objetos**: el nombre de un objeto de Storage ya no se usa crudo como ruta; se valida (rechaza rutas absolutas y segmentos `..`) con la misma regla que aplica el consumidor del respaldo.
- **TLS desactivado para bases remotas**: fuera de loopback el certificado se verifica (`rejectUnauthorized: true`); el TLS apagado queda solo para el stack local.
- **El `BACKUP_DIR` del operador se pisaba**: el orquestador ya no reescribe esa variable; creador, registro y restauracion hablan del mismo destino (`BACKUPS_DIR`), que se puede llevar a otro volumen.
- **Un origen que no volvia a levantar pasaba inadvertido**: el `trap` verifica que los contenedores volvieron y, si no, el ensayo termina con codigo distinto de 0.
- **Documentacion**: `docs/respaldos.md` describia un layout `storage/<bucket>/<ruta>` que nunca existio (es `storage/<ruta>`) y atribuia al orquestador una comprobacion que no hacia.

Evidencia observada en esta maquina: el ciclo completo (`bash scripts/dev/backup-and-verify-restore.sh`) sale **0** con el origen detenido y su URL inaccesible; los cuatro casos negativos (archivo faltante, hash alterado, manifiesto corrupto, archivo no declarado) salen **1** con el mensaje estructurado y dejan su linea `resultado: "FALLO"` en el registro; el respaldo con `BACKUPS_DIR` en un directorio temporal nace ahi (no en el destino por omision) con permisos 700/600; la suite completa de la API queda en **389 pruebas** (31 archivos) y el typecheck limpio.


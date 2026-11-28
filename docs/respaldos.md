# Respaldo y restauración

Un respaldo del CRM es un **directorio autocontenido** en disco con:

- `public.sql` — volcado plano del esquema `public` (**esquema y datos**, sin
  privilegios: los fija el repo, que es su fuente de verdad).
- `storage/<ruta>` — copia binaria de cada objeto del bucket
  `whatsapp-media`, con la misma ruta que tenía en el bucket (sin nivel
  intermedio de bucket).
- `manifest.json` — metadatos del respaldo: instancia, commit, fecha, ledger
  de `schema_migrations`, credenciales de la cuenta de muestra, ids de
  cliente/chat/mensaje, extensiones que el esquema necesita, objetos fuera de
  `public` de los que depende (en Supabase, `auth.users`), filas por tabla
  del volcado y, para cada archivo, su tamaño, su hash **sha256** y su tipo
  de contenido.

El directorio se crea con permisos **700** y sus archivos con **600**: el
manifiesto lleva la contraseña de la cuenta de muestra.

La contraseña de la muestra **se genera al vuelo en cada respaldo**: no hay
ninguna contraseña escrita en el código. El manifiesto es el único lugar donde
queda, porque es el artefacto que permite recrear la cuenta en el destino.

La restauración se demuestra desde ese directorio, **sin conectarse al
origen**: se detienen los contenedores del origen, se reconstruye el destino
con las migraciones del repo y se vuelcan la muestra y los adjuntos desde
los archivos locales.

## Por qué el manifiesto lleva lo que lleva

El manifiesto no es un adorno: es lo que permite **aplicar el volcado** en una
base limpia y **comprobar que contiene los datos**.

- **Filas por tabla** (`tableCounts`): son el término de comparación. El
  ensayo aplica `public.sql` en una base de datos de prueba del Postgres de
  destino y compara los conteos: si el volcado no trae los datos, el ensayo
  falla.
- **Extensiones** (`extensions`): `pg_dump --schema=public` no las incluye
  (son objetos de base, no de esquema). Sin ellas, el índice `gin_trgm_ops`
  no se puede crear.
- **Dependencias externas** (`externalDependencies`): las claves foráneas del
  esquema `public` que apuntan a `auth.users`, que administra GoTrue y **no**
  está en el respaldo. El manifiesto dice qué hace falta para poder aplicar
  el volcado.
- **Tipo de contenido** (`contentType`): un adjunto que no es texto tiene que
  volver con SU tipo, no con `text/plain`.


## Cómo se crea

```bash
cd apps/api && pnpm exec tsx scripts/create-backup.ts
```

El script:

1. Crea o recrea una cuenta, chat, mensaje y archivo de muestra en el origen
   (la contraseña se genera al vuelo) y falla si algo de ese paso falla.
2. Ejecuta `pg_dump` dentro del contenedor del origen y copia el volcado a
   disco.
3. Lista y descarga cada objeto del bucket `whatsapp-media`, guardando su
   tipo de contenido y validando que el nombre del objeto no se salga del
   directorio del respaldo.
4. Registra las extensiones que el esquema necesita, los objetos externos de
   los que depende y las filas por tabla del volcado.
5. Escribe `manifest.json` con los hashes sha256 de cada archivo.
6. Imprime la ruta del directorio de respaldo.

### Perillas

| Perilla | Para qué |
|---|---|
| `BACKUPS_DIR` | Directorio donde se crean los respaldos (por omisión `~/supabase-dev/backups`). |
| `BACKUP_DIR` | Directorio **exacto** de este respaldo. Si ya existe, el creador se niega a escribir. |
| `ORIGIN_PROJECT` | Id del proyecto del stack de origen (por omisión `onano-support-dev`). |
| `ORIGIN_DB_CONTAINER` | Contenedor de Postgres del origen. |
| `ORIGIN_STACK_DIR` | Directorio del stack de origen. |

## Cómo se verifica

```bash
bash scripts/dev/backup-and-verify-restore.sh
```

El orquestador:

1. Resuelve la URL del origen (`SUPABASE_URL` del entorno y, si no está,
   `apps/api/.env`). **Si no la puede resolver, falla**: sin esa URL no se
   puede comprobar que el origen esté inaccesible.
2. Crea el respaldo (en `BACKUPS_DIR`, o en `BACKUP_DIR` si el operador lo
   fijó).
3. Detiene los contenedores del origen (`supabase_db_*`, `supabase_rest_*`,
   `supabase_auth_*`, `supabase_kong_*`, `supabase_storage_*`).
4. Ejecuta `restore-rehearsal.ts --backup <dir>`, que:
   - verifica que cada archivo exista, que su tamaño coincida, que su sha256
     coincida y que **no haya archivos de `storage/` que el manifiesto no
     declare**;
   - aplica `public.sql` en una base de datos de prueba del Postgres de
     destino (preparando las extensiones y las tablas de las que dependen las
     claves foráneas) y compara los conteos por tabla con los del manifiesto;
   - limpia y recrea el esquema `public` en el destino;
   - aplica las migraciones del repo (los privilegios los fijan ellas, no el
     volcado);
   - crea la cuenta de muestra en el destino con la contraseña del manifiesto;
   - inserta las filas de muestra y sube los adjuntos **con el tipo de
     contenido que declara el manifiesto**;
   - inicia sesión en el destino y llama a `/api/me` y
     `/api/conversations/[id]` para comprobar identidad, permisos, relación
     cuenta-chat-cliente, historial y bytes del adjunto.
5. Comprueba que el origen está **inalcanzable**: `docker ps` no lo muestra
   corriendo y un `curl` a la URL del origen no responde. Si el `curl`
   respondiera, el ensayo falla: la demostración sería falsa.
6. Vuelve a arrancar el origen en un `trap`, aunque la restauración falle, y
   **comprueba que volvió**: un origen apagado deja la base de desarrollo
   caída, así que el ensayo tampoco puede terminar en verde.
7. Imprime el veredicto y el último registro añadido a
   `~/supabase-dev/backups/registry.jsonl` (o a `$BACKUPS_DIR/registry.jsonl`).

## Qué falla y cómo

- **Falta un archivo del respaldo** → `verifyBackupIntegrity` devuelve error
  con el nombre del archivo; `restore-rehearsal.ts` sale con código 1.
- **Un archivo está dañado** → el sha256 no coincide; el error nombra el
  archivo, el hash esperado y el encontrado.
- **Un archivo cambió de tamaño** → el error nombra el archivo, el tamaño
  esperado y el encontrado.
- **El manifiesto no declara ningún archivo** → es un fallo: un respaldo sin
  archivos no prueba nada.
- **Hay un archivo en `storage/` que el manifiesto no declara** → es un fallo
  y el archivo se nombra: un respaldo manipulado no se restaura en silencio.
- **El manifiesto está corrupto o mal formado** → el fallo sale con el
  mensaje estructurado (`FALLO en ...`), nunca con una excepción cruda.
- **El volcado no se puede aplicar** o sus conteos no reproducen los del
  manifiesto → el ensayo falla en el paso `volcado`.

- **El origen sigue activo durante la restauración** → el orquestador
  comprueba `docker ps` **y** `curl` contra la URL del origen, y falla si
  cualquiera de los dos dice que el origen sigue ahí.
- **La restauración no verifica identidad/permisos/historial/bytes** → la
  salida dice `FALLO` y el registro queda como `resultado: "FALLO"`.

## En CI

`.github/workflows/backup-restore.yml` repite el ciclo completo sobre una
instancia efímera de Supabase. El origen es el stack efímero de CI; el
destino es una segunda instancia con puertos remapeados. Si el segundo stack
no arranca por conflictos de puertos o recursos, el job falla y se reporta el
problema; no se simula un destino.

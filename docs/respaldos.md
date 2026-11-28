# Respaldo y restauración

Un respaldo del CRM es un **directorio autocontenido** en disco con:

- `public.sql` — volcado plano del esquema `public`.
- `storage/<bucket>/<ruta-del-objeto>` — copia binaria de cada objeto del
  bucket `whatsapp-media`.
- `manifest.json` — metadatos del respaldo: instancia, commit, fecha, ledger
  de `schema_migrations`, credenciales de la cuenta de muestra, ids de
  cliente/chat/mensaje y, para cada archivo, su tamaño y hash **sha256**.

La restauración se demuestra desde ese directorio, **sin conectarse al
origen**: se detienen los contenedores del origen, se reconstruye el destino
con las migraciones del repo y se vuelcan la muestra y los adjuntos desde
los archivos locales.

## Cómo se crea

```bash
cd apps/api && pnpm exec tsx scripts/create-backup.ts
```

El script:

1. Crea o recrea una cuenta, chat, mensaje y archivo de muestra en el origen.
2. Ejecuta `pg_dump` dentro del contenedor del origen y copia el volcado a
   disco.
3. Lista y descarga cada objeto del bucket `whatsapp-media`.
4. Escribe `manifest.json` con los hashes sha256 de cada archivo.
5. Imprime la ruta del directorio de respaldo.

## Cómo se verifica

```bash
bash scripts/dev/backup-and-verify-restore.sh
```

El orquestador:

1. Crea el respaldo.
2. Detiene los contenedores del origen (`supabase_db_*`, `supabase_rest_*`,
   `supabase_auth_*`, `supabase_kong_*`, `supabase_storage_*`).
3. Ejecuta `restore-rehearsal.ts --backup <dir>`, que:
   - verifica que cada archivo exista y que su sha256 coincida;
   - limpia y recrea el esquema `public` en el destino;
   - aplica las migraciones del repo;
   - crea la cuenta de muestra en el destino con la contraseña del manifiesto;
   - inserta las filas de muestra y sube los adjuntos;
   - inicia sesión en el destino y llama a `/api/me` y
     `/api/conversations/[id]` para comprobar identidad, permisos, relación
     cuenta-chat-contacto, historial y bytes del adjunto.
4. Vuelve a arrancar el origen en un `trap`, aunque la restauración falle.
5. Imprime el veredicto y el último registro añadido a
   `~/supabase-dev/backups/registry.jsonl`.

## Qué falla y cómo

- **Falta un archivo del respaldo** → `verifyBackupIntegrity` devuelve error
  con el nombre del archivo; `restore-rehearsal.ts` sale con código 1.
- **Un archivo está dañado** → el sha256 no coincide; el error nombra el
  archivo, el hash esperado y el encontrado.
- **El origen sigue activo durante la restauración** → el orquestador
  comprueba `docker ps` y falla si los contenedores del origen aún corren.
- **La restauración no verifica identidad/permisos/historial/bytes** → la
  salida dice `FALLO` y el registro queda como `resultado: "FALLO"`.

## En CI

`.github/workflows/backup-restore.yml` repite el ciclo completo sobre una
instancia efímera de Supabase. El origen es el stack efímero de CI; el
destino es una segunda instancia con puertos remapeados. Si el segundo stack
no arranca por conflictos de puertos o recursos, el job falla y se reporta el
problema; no se simula un destino.

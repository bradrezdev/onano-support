#!/usr/bin/env bash
# Respaldo de la base de desarrollo y demostración de que se restaura en otra
# instancia.
#
# Qué deja:
#   1 · un volcado (formato custom de pg_dump) del esquema `public` —el del
#       CRM— con sus datos, en un archivo FUERA de la base;
#   2 · una restauración real en OTRA instancia (un contenedor postgres nuevo,
#       sin nada de Supabase) para demostrar que el volcado sirve;
#   3 · el conteo de filas de las tablas clave en la copia restaurada, para
#      cotejar contra el original.
#
# Dónde queda el esquema que protege a la base: el REPO (`supabase/migrations`),
# no la base. El ledger `public.schema_migrations` dentro de la base es solo
# contabilidad de lo que YA se aplicó; la verdad son los archivos versionados.
#
#   bash scripts/dev/backup-and-verify-restore.sh
set -euo pipefail

STACK_DIR="${SUPABASE_STACK_DIR:-$HOME/supabase-dev/onano-support-dev}"
BACKUP_DIR="${BACKUP_DIR:-$HOME/supabase-dev/backups}"
PROJECT="onano-support-dev"
CONTAINER="supabase_db_${PROJECT}"
STAMP="$(date +%Y%m%d-%H%M%S)"
DUMP="${BACKUP_DIR}/${PROJECT}-${STAMP}.dump"

mkdir -p "${BACKUP_DIR}"

if ! docker ps --format '{{.Names}}' | grep -qx "${CONTAINER}"; then
  echo "No está corriendo el stack de desarrollo (${CONTAINER})." >&2
  exit 1
fi

echo "== 1 · volcado del esquema public =="
docker exec "${CONTAINER}" pg_dump -U postgres -d postgres --format=custom --schema=public --file=/tmp/backup.dump
docker cp "${CONTAINER}:/tmp/backup.dump" "${DUMP}"
docker exec "${CONTAINER}" rm -f /tmp/backup.dump
SIZE="$(du -h "${DUMP}" | cut -f1)"
echo "   ${DUMP} (${SIZE})"

echo
echo "== 2 · conteos en el original =="
ORIGINAL="$(docker exec "${CONTAINER}" psql -U postgres -d postgres -tAc "
  select 'profiles='||(select count(*) from public.profiles)
      ||' contacts='||(select count(*) from public.contacts)
      ||' conversations='||(select count(*) from public.conversations)
      ||' messages='||(select count(*) from public.messages)
      ||' tickets='||(select count(*) from public.tickets)
      ||' migraciones='||(select count(*) from public.schema_migrations);")"
echo "   ${ORIGINAL}"

echo
echo "== 3 · restauración en OTRA instancia (contenedor postgres nuevo) =="
RESTORE_CONTAINER="crm_restore_check"
docker rm -f "${RESTORE_CONTAINER}" > /dev/null 2>&1 || true
docker run -d --name "${RESTORE_CONTAINER}" -e POSTGRES_PASSWORD=postgres postgres:15 > /dev/null
for i in $(seq 1 30); do
  if docker exec "${RESTORE_CONTAINER}" pg_isready -U postgres > /dev/null 2>&1; then break; fi
  sleep 1
done
docker cp "${DUMP}" "${RESTORE_CONTAINER}:/tmp/backup.dump"
docker exec "${RESTORE_CONTAINER}" pg_restore -U postgres -d postgres --clean --if-exists --no-owner --no-privileges /tmp/backup.dump > /tmp/restore.log 2>&1 || {
  echo "   La restauración reportó avisos (revisar /tmp/restore.log):" >&2
  tail -5 /tmp/restore.log >&2
}
RESTORED="$(docker exec "${RESTORE_CONTAINER}" psql -U postgres -d postgres -tAc "
  select 'profiles='||(select count(*) from public.profiles)
      ||' contacts='||(select count(*) from public.contacts)
      ||' conversations='||(select count(*) from public.conversations)
      ||' messages='||(select count(*) from public.messages)
      ||' tickets='||(select count(*) from public.tickets)
      ||' migraciones='||(select count(*) from public.schema_migrations);")"
echo "   ${RESTORED}"

echo
if [ "${ORIGINAL}" = "${RESTORED}" ]; then
  echo "== OK · el volcado se restauró íntegro en otra instancia =="
  echo "   ${DUMP}"
  docker rm -f "${RESTORE_CONTAINER}" > /dev/null
else
  echo "== FALLO · los conteos no coinciden ==" >&2
  echo "   original:  ${ORIGINAL}" >&2
  echo "   restaurado:${RESTORED}" >&2
  docker rm -f "${RESTORE_CONTAINER}" > /dev/null
  exit 1
fi

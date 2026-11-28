#!/usr/bin/env bash
# Respaldo de la base de desarrollo y demostración de que se restaura desde
# disco con el origen desconectado.
#
# Qué hace:
#   1 · Crea un respaldo autocontenido con create-backup.ts (esquema public,
#       objetos de whatsapp-media y manifiesto con sha256).
#   2 · Detiene los contenedores del origen para demostrar que la restauración
#       no depende de él.
#   3 · Restaura el respaldo en la instancia de restauración con
#       restore-rehearsal.ts.
#   4 · Vuelve a arrancar el origen (incluso si la restauración falla).
#   5 · Imprime el veredicto y el registro que se añadió.
#
#   bash scripts/dev/backup-and-verify-restore.sh
set -euo pipefail

PROJECT="onano-support-dev"
ORIGIN_CONTAINERS=(
  "supabase_db_${PROJECT}"
  "supabase_rest_${PROJECT}"
  "supabase_auth_${PROJECT}"
  "supabase_kong_${PROJECT}"
  "supabase_storage_${PROJECT}"
)
REGISTRY="${HOME}/supabase-dev/backups/registry.jsonl"
# URL pública del origen (la que tiene el .env de la API). Se toma ANTES de
# cambiar de directorio, porque el script entra en apps/api.
ORIGIN_API="$(grep -E '^SUPABASE_URL=' apps/api/.env | head -n 1 | cut -d= -f2- | tr -d '"' || true)"

restore_origin() {
  echo "== (trap) reanudando origen =="
  docker start "${ORIGIN_CONTAINERS[@]}" > /dev/null 2>&1 || true
}
trap restore_origin EXIT

echo "== 1 · crear respaldo =="
BACKUP_DIR="$(cd apps/api && pnpm exec tsx scripts/create-backup.ts | tail -n 1)"
if [ -z "${BACKUP_DIR}" ] || [ ! -d "${BACKUP_DIR}" ]; then
  echo "No se pudo crear el respaldo." >&2
  exit 1
fi
echo "   respaldo=${BACKUP_DIR}"

echo
echo "== 2 · detener origen =="
docker stop "${ORIGIN_CONTAINERS[@]}" > /dev/null 2>&1 || true
sleep 2
RUNNING_ORIGIN="$(docker ps --format '{{.Names}}' | grep -E "^supabase_(db|rest|auth|kong|storage)_${PROJECT}$" || true)"
if [ -n "${RUNNING_ORIGIN}" ]; then
  echo "No se pudo detener el origen completamente:" >&2
  echo "${RUNNING_ORIGIN}" >&2
  exit 1
fi
echo "   origen detenido"

echo
echo "== 3 · restaurar desde disco (origen desconectado) =="
RESTORE_EXIT=0
cd apps/api && pnpm exec tsx scripts/restore-rehearsal.ts --backup "${BACKUP_DIR}" || RESTORE_EXIT=$?

echo
echo "== 4 · prueba de desconexión del origen =="
RUNNING_DURING_RESTORE="$(docker ps --format '{{.Names}}' | grep -E "^supabase_(db|rest|auth|kong|storage)_${PROJECT}$" || true)"
if [ -n "${RUNNING_DURING_RESTORE}" ]; then
  # El origen estaba arriba durante la restauración: la demostración es falsa
  # (la restauración pudo haberlo usado). Esto es un fallo, no un aviso.
  echo "FALLO: el origen estaba arriba durante la restauración:" >&2
  echo "${RUNNING_DURING_RESTORE}" >&2
  exit 1
elif [ -n "${ORIGIN_API}" ] && curl -s -o /dev/null --max-time 5 "${ORIGIN_API}/auth/v1/health"; then
  echo "FALLO: el origen SIGUE RESPONDIENDO en ${ORIGIN_API}." >&2
  echo "   La restauración no se puede haber hecho sin él: la demostración es falsa." >&2
  exit 1
else
  echo "   Origen desconectado durante la restauración: sin contenedores y ${ORIGIN_API} inaccesible."
fi

echo
if [ "${RESTORE_EXIT}" -ne 0 ]; then
  echo "== FALLO · la restauración no pudo reconstruir el respaldo ==" >&2
  exit "${RESTORE_EXIT}"
fi

echo "== OK · el respaldo se restauró y verificó con el origen apagado =="
echo "   backup_dir=${BACKUP_DIR}"
if [ -f "${REGISTRY}" ]; then
  echo "   registro="
  tail -n 1 "${REGISTRY}"
else
  echo "   (sin registro)"
fi

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
#   4 · Comprueba que el origen está INALCANZABLE: sin contenedores y con la
#       URL del origen sin responder.
#   5 · Vuelve a arrancar el origen (incluso si la restauración falla) y
#       comprueba que volvió.
#   6 · Imprime el veredicto y el registro que se añadió.
#
# Perillas (las mismas que honra create-backup.ts):
#   ORIGIN_PROJECT      · id del proyecto del stack de origen.
#   ORIGIN_DB_CONTAINER · contenedor de Postgres del origen.
#   BACKUPS_DIR         · directorio donde se crean los respaldos y el registro.
#   BACKUP_DIR          · directorio exacto del respaldo (lo fija el operador).
#   SUPABASE_URL        · URL del origen; si no está, se lee de apps/api/.env.
#
#   bash scripts/dev/backup-and-verify-restore.sh
set -euo pipefail

# Las mismas perillas que el creador del respaldo: el orquestador detiene la
# MISMA instancia que respaldó, no una escrita a mano.
ORIGIN_PROJECT="${ORIGIN_PROJECT:-onano-support-dev}"
ORIGIN_DB_CONTAINER="${ORIGIN_DB_CONTAINER:-supabase_db_${ORIGIN_PROJECT}}"
ORIGIN_CONTAINERS=(
  "${ORIGIN_DB_CONTAINER}"
  "supabase_rest_${ORIGIN_PROJECT}"
  "supabase_auth_${ORIGIN_PROJECT}"
  "supabase_kong_${ORIGIN_PROJECT}"
  "supabase_storage_${ORIGIN_PROJECT}"
)
export ORIGIN_PROJECT ORIGIN_DB_CONTAINER

# El directorio de respaldos lo fija el operador y lo comparten el creador,
# el registro y la restauración.
BACKUPS_ROOT="${BACKUPS_DIR:-${HOME}/supabase-dev/backups}"
export BACKUPS_DIR="${BACKUPS_ROOT}"
REGISTRY="${BACKUPS_ROOT}/registry.jsonl"

# URL pública del origen: primero el entorno, después apps/api/.env. Si no se
# puede resolver NO se puede demostrar que el origen esté desconectado, así
# que es un fallo y no un salto opcional.
ORIGIN_API="${SUPABASE_URL:-}"
if [ -z "${ORIGIN_API}" ] && [ -f apps/api/.env ]; then
  ORIGIN_API="$(grep -E '^SUPABASE_URL=' apps/api/.env | head -n 1 | cut -d= -f2- | tr -d '"' || true)"
fi
if [ -z "${ORIGIN_API}" ]; then
  echo "FALLO: no se pudo resolver la URL del origen (SUPABASE_URL en el entorno o en apps/api/.env)." >&2
  echo "   Sin esa URL no se puede comprobar que el origen esté inaccesible." >&2
  exit 1
fi

# Nombres exactos de los contenedores del origen que siguen corriendo.
contenedores_vivos() {
  local vivos=""
  for c in "${ORIGIN_CONTAINERS[@]}"; do
    if docker ps --format '{{.Names}}' | grep -qx "${c}"; then
      vivos="${vivos}${c} "
    fi
  done
  echo "${vivos}"
}

# Nombres exactos de los contenedores del origen que NO están corriendo.
contenedores_faltantes() {
  local faltan=""
  for c in "${ORIGIN_CONTAINERS[@]}"; do
    if ! docker ps --format '{{.Names}}' | grep -qx "${c}"; then
      faltan="${faltan}${c} "
    fi
  done
  echo "${faltan}"
}

# Docker tarda en reportar el estado: se espera, no se supone.
esperar_sin_origen() {
  local i
  for i in $(seq 1 30); do
    if [ -z "$(contenedores_vivos)" ]; then
      return 0
    fi
    sleep 1
  done
  return 1
}

esperar_con_origen() {
  local i
  for i in $(seq 1 30); do
    if [ -z "$(contenedores_faltantes)" ]; then
      return 0
    fi
    sleep 1
  done
  return 1
}

restore_origin() {
  local exit_code=$?
  echo "== (trap) reanudando origen =="
  docker start "${ORIGIN_CONTAINERS[@]}" > /dev/null 2>&1 || true
  if esperar_con_origen; then
    echo "   origen reanudado"
  else
    # Un origen que no vuelve a levantar deja la base de desarrollo apagada:
    # el ensayo no puede terminar en verde diciendo que todo salió bien.
    echo "FALLO: el origen NO volvió a levantar. La base de desarrollo quedó apagada:" >&2
    echo "$(contenedores_faltantes)" >&2
    if [ "${exit_code}" -eq 0 ]; then
      exit_code=1
    fi
  fi
  exit "${exit_code}"
}
trap restore_origin EXIT

echo "== 1 · comprobación previa: el origen responde =="
# La prueba de desconexión solo vale si el origen contestaba ANTES: si la URL
# está mal, el `curl` posterior fallaría por la URL y no por el origen apagado.
if ! curl -s -o /dev/null --max-time 5 "${ORIGIN_API}/auth/v1/health"; then
  echo "FALLO: el origen no responde en ${ORIGIN_API} antes de detenerlo." >&2
  echo "   Sin una respuesta previa, la comprobación de desconexión no probaría nada." >&2
  exit 1
fi
echo "   origen accesible en ${ORIGIN_API}"

echo
echo "== 2 · crear respaldo =="
CREATED_BACKUP="$(cd apps/api && pnpm exec tsx scripts/create-backup.ts | tail -n 1)"
if [ -z "${CREATED_BACKUP}" ] || [ ! -d "${CREATED_BACKUP}" ]; then
  echo "No se pudo crear el respaldo." >&2
  exit 1
fi
echo "   respaldo=${CREATED_BACKUP}"

echo
echo "== 3 · detener origen =="
docker stop "${ORIGIN_CONTAINERS[@]}" > /dev/null 2>&1 || true
if ! esperar_sin_origen; then
  echo "No se pudo detener el origen completamente:" >&2
  echo "$(contenedores_vivos)" >&2
  exit 1
fi
echo "   origen detenido"

echo
echo "== 4 · restaurar desde disco (origen desconectado) =="
RESTORE_EXIT=0
cd apps/api && pnpm exec tsx scripts/restore-rehearsal.ts --backup "${CREATED_BACKUP}" || RESTORE_EXIT=$?

echo
echo "== 5 · prueba de desconexión del origen =="
RUNNING_DURING_RESTORE="$(contenedores_vivos)"
if [ -n "${RUNNING_DURING_RESTORE}" ]; then
  # El origen estaba arriba durante la restauración: la demostración es falsa
  # (la restauración pudo haberlo usado). Esto es un fallo, no un aviso.
  echo "FALLO: el origen estaba arriba durante la restauración:" >&2
  echo "${RUNNING_DURING_RESTORE}" >&2
  exit 1
fi
# La comprobación por URL es OBLIGATORIA: si el origen responde, la
# restauración pudo haberlo usado y la demostración es falsa.
if curl -s -o /dev/null --max-time 5 "${ORIGIN_API}/auth/v1/health"; then
  echo "FALLO: el origen SIGUE RESPONDIENDO en ${ORIGIN_API}." >&2
  echo "   La restauración no se puede haber hecho sin él: la demostración es falsa." >&2
  exit 1
fi
echo "   Origen desconectado durante la restauración: sin contenedores y ${ORIGIN_API} inaccesible."

echo
if [ "${RESTORE_EXIT}" -ne 0 ]; then
  echo "== FALLO · la restauración no pudo reconstruir el respaldo ==" >&2
  exit "${RESTORE_EXIT}"
fi

echo "== OK · el respaldo se restauró y verificó con el origen apagado =="
echo "   backup_dir=${CREATED_BACKUP}"
if [ -f "${REGISTRY}" ]; then
  echo "   registro="
  tail -n 1 "${REGISTRY}"
else
  echo "   (sin registro)"
fi

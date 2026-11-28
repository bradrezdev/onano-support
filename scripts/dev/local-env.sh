#!/usr/bin/env bash
# Escribe los archivos .env de la app contra la instancia LOCAL de Supabase.
#
# El destino de desarrollo es el stack local (Supabase CLI + Docker), que es
# persistente (volumen Docker) y está aislado tanto del CI como del proyecto
# alojado anterior. Este script lee las claves del stack vivo —no las lleva
# escritas— y deja las variables en `apps/api/.env` y `apps/web/.env`.
#
# Variables de Twilio (webhook entrante): se COPIAN si están en el entorno y
# nunca se inventan valores.
#   · TWILIO_AUTH_TOKEN — la credencial con la que se valida la firma del
#     webhook. Sin ella el webhook responde 503: la validación nunca se omite.
#   · WEBHOOK_BASE_URL — el origen PÚBLICO del webhook (p. ej.
#     http://localhost:3000). La firma se valida contra `WEBHOOK_BASE_URL` +
#     ruta + query string, nunca contra `request.url`. Sin ella el webhook
#     responde 503.
# Para que sobrevivan a la regeneración del `.env`, expónlas antes de correr
# el script:
#   export TWILIO_AUTH_TOKEN=... WEBHOOK_BASE_URL=http://localhost:3000
#   bash scripts/dev/local-env.sh
#
# El `.env` anterior (proyecto alojado) se conserva como `.env.legacy`: ese
# proyecto es la fuente de recuperación del historial y se consulta a mano,
# nunca se escribe.
#
#   bash scripts/dev/local-env.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STACK_DIR="${SUPABASE_STACK_DIR:-$HOME/supabase-dev/onano-support-dev}"

if [ ! -f "${STACK_DIR}/supabase/config.toml" ]; then
  echo "No encuentro el stack local en ${STACK_DIR}." >&2
  echo "Cópialo desde supabase/ci/config.toml y arranca con 'supabase start'." >&2
  exit 1
fi

cd "${STACK_DIR}"
supabase status -o env > /tmp/sb-local-env.sh

read_env() {
  # Imprime el valor de una clave del archivo `supabase status -o env`,
  # sin las comillas que la CLI pone alrededor.
  python3 - "$1" <<'PY'
import sys
key = sys.argv[1]
for line in open('/tmp/sb-local-env.sh'):
    line = line.strip()
    if line.startswith(key + '='):
        value = line.split('=', 1)[1].strip()
        if len(value) >= 2 and value[0] == value[-1] == '"':
            value = value[1:-1]
        print(value)
        break
PY
}

API_URL="$(read_env API_URL)"
SECRET_KEY="$(read_env SECRET_KEY)"
PUBLISHABLE_KEY="$(read_env PUBLISHABLE_KEY)"
DB_URL="$(read_env DB_URL)"

# Las variables de Twilio SOLO se copian si el entorno las trae: el script
# nunca inventa una credencial. Sin ellas el webhook entrante responde 503.
TWILIO_AUTH_TOKEN="${TWILIO_AUTH_TOKEN:-}"
WEBHOOK_BASE_URL="${WEBHOOK_BASE_URL:-}"

if [ -z "${API_URL}" ] || [ -z "${SECRET_KEY}" ] || [ -z "${PUBLISHABLE_KEY}" ] || [ -z "${DB_URL}" ]; then
  echo "El stack local no publicó todas las claves. ¿Está corriendo 'supabase start'?" >&2
  exit 1
fi

# Preservar el .env anterior (proyecto alojado) antes de sobrescribir.
for app in api web; do
  if [ -f "${REPO_ROOT}/apps/${app}/.env" ] && [ ! -f "${REPO_ROOT}/apps/${app}/.env.legacy" ]; then
    cp "${REPO_ROOT}/apps/${app}/.env" "${REPO_ROOT}/apps/${app}/.env.legacy"
    echo "Guardado el .env anterior en apps/${app}/.env.legacy"
  fi
done

cat > "${REPO_ROOT}/apps/api/.env" <<EOF
# Entorno de DESARROLLO LOCAL (stack de Supabase CLI + Docker).
# Generado por scripts/dev/local-env.sh — no editar a mano.
SUPABASE_URL=${API_URL}
SUPABASE_SECRET_KEY=${SECRET_KEY}
NEXT_PUBLIC_SUPABASE_URL=${API_URL}
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=${PUBLISHABLE_KEY}
DATABASE_URL=${DB_URL}
CORS_ORIGINS=http://localhost:5173,http://127.0.0.1:5173
${TWILIO_AUTH_TOKEN:+TWILIO_AUTH_TOKEN=${TWILIO_AUTH_TOKEN}}
${WEBHOOK_BASE_URL:+WEBHOOK_BASE_URL=${WEBHOOK_BASE_URL}}
EOF

cat > "${REPO_ROOT}/apps/web/.env" <<EOF
# Entorno de DESARROLLO LOCAL (stack de Supabase CLI + Docker).
# Generado por scripts/dev/local-env.sh — no editar a mano.
VITE_API_BASE_URL=http://localhost:3000
VITE_SUPABASE_URL=${API_URL}
VITE_SUPABASE_ANON_KEY=${PUBLISHABLE_KEY}
EOF

echo "Listo: apps/api/.env y apps/web/.env apuntan al stack local."
echo "El proyecto alojado anterior quedó en apps/*/.env.legacy (solo lectura)."

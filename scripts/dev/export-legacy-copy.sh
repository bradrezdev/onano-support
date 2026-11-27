#!/usr/bin/env bash
# Copia privada del historial recuperable del proyecto ANTERIOR.
#
# El proyecto alojado anterior (`nlhfnryxvpzqynvyiduw`) fue restaurado por
# la plataforma: su esquema volvió y trae los datos que existían en el punto
# de restauración. Ese proyecto se queda en modo CONSULTA: no se le escribe.
#
# Este script deja esa historia en una copia privada SEPARADA (un Postgres
# propio, con volumen, que no es ni el proyecto anterior ni el entorno de
# desarrollo) y luego inventaría lo que hay en ella: contactos, chats,
# mensajes, asignaciones y adjuntos.
#
#   bash scripts/dev/export-legacy-copy.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LEGACY_ENV="${REPO_ROOT}/apps/api/.env.legacy"
COPY_CONTAINER="crm_legacy_copy"
COPY_VOLUME="crm_legacy_copy_data"
DUMP_DIR="${BACKUP_DIR:-$HOME/supabase-dev/backups}"
STAMP="$(date +%Y%m%d-%H%M%S)"
DUMP="${DUMP_DIR}/legacy-public-${STAMP}.dump"

mkdir -p "${DUMP_DIR}"

if [ ! -f "${LEGACY_ENV}" ]; then
  echo "No encuentro ${LEGACY_ENV}: el .env del proyecto anterior no se conservó." >&2
  exit 1
fi

# Credenciales del proyecto anterior SOLO para leer (el dump es una lectura).
# Se pasan por entorno para no dejarlas en la línea de comandos.
LEGACY_DATABASE_URL="$(grep -E '^DATABASE_URL=' "${LEGACY_ENV}" | head -1 | cut -d= -f2-)"
if [ -z "${LEGACY_DATABASE_URL}" ]; then
  echo "El .env anterior no tiene DATABASE_URL." >&2
  exit 1
fi
PGPASSWORD="$(python3 -c "
import sys, urllib.parse
u = urllib.parse.urlparse(sys.argv[1])
print(urllib.parse.unquote(u.password or ''))
" "${LEGACY_DATABASE_URL}")"
PGHOST="$(python3 -c "
import sys, urllib.parse
print(urllib.parse.urlparse(sys.argv[1]).hostname)
" "${LEGACY_DATABASE_URL}")"
# El host resuelve a IPv6 y el contenedor de pg_dump no tiene ruta IPv6:
# se le da la dirección IPv4 explícita (PGHOSTADDR).
PGHOSTADDR="$(python3 -c "
import socket, sys, time
host = sys.argv[1]
for intento in range(6):
    try:
        for info in socket.getaddrinfo(host, 5432, socket.AF_INET):
            print(info[4][0]); sys.exit(0)
    except socket.gaierror:
        time.sleep(3)
print('')
" "${PGHOST}")"
if [ -z "${PGHOSTADDR}" ]; then
  echo "No se pudo resolver la dirección IPv4 de ${PGHOST} (DNS intermitente)." >&2
  echo "Vuelve a intentarlo: el proyecto anterior sigue siendo accesible en modo consulta." >&2
  exit 1
fi
echo "   destino: ${PGHOST} (${PGHOSTADDR})"

echo "== 1 · volcado de solo lectura del esquema public del proyecto anterior =="
# El contenedor escribe el archivo en el directorio del host (montaje), así
# que el volcado nunca pasa por la línea de comandos.
docker run --rm -e PGPASSWORD="${PGPASSWORD}" -e PGHOSTADDR="${PGHOSTADDR}" \
  -v "$(dirname "${DUMP}"):/out" postgres:15 \
  pg_dump -h "${PGHOST}" -U postgres -d postgres --format=custom --schema=public \
  --file="/out/$(basename "${DUMP}")" > /dev/null
echo "   ${DUMP}"

echo
echo "== 2 · copia privada separada (contenedor y volumen propios) =="
if ! docker ps -a --format '{{.Names}}' | grep -qx "${COPY_CONTAINER}"; then
  docker run -d --name "${COPY_CONTAINER}" \
    -e POSTGRES_PASSWORD=postgres \
    -v "${COPY_VOLUME}:/var/lib/postgresql/data" postgres:15 > /dev/null
fi
for i in $(seq 1 30); do
  if docker exec "${COPY_CONTAINER}" pg_isready -U postgres > /dev/null 2>&1; then break; fi
  sleep 1
done
docker cp "${DUMP}" "${COPY_CONTAINER}:/tmp/legacy.dump"
docker exec "${COPY_CONTAINER}" pg_restore -U postgres -d postgres --clean --if-exists /tmp/legacy.dump > /tmp/legacy-restore.log 2>&1 || true
echo "   contenedor=${COPY_CONTAINER} volumen=${COPY_VOLUME}"
echo "   (los avisos de roles son esperables: la copia no tiene los roles de Supabase)"

echo
echo "== 3 · inventario de lo recuperable =="
docker exec "${COPY_CONTAINER}" psql -U postgres -d postgres -tAc "
  select 'perfiles='||(select count(*) from public.profiles)
      ||' contactos='||(select count(*) from public.contacts)
      ||' conversaciones='||(select count(*) from public.conversations)
      ||' mensajes='||(select count(*) from public.messages)
      ||' tickets='||(select count(*) from public.tickets)
      ||' asignaciones='||(select count(*) from public.tickets where assigned_to is not null)
      ||' migraciones='||(select count(*) from public.schema_migrations);"

echo
echo "== 4 · asignaciones (quién-atendía-qué) =="
docker exec "${COPY_CONTAINER}" psql -U postgres -d postgres -tAc "
  select coalesce(p.display_name, '(sin perfil)')||' -> '||coalesce(t.name,'(sin ticket)')
    from public.tickets t left join public.profiles p on p.id = t.assigned_to
   order by 1;"

echo
echo "== 5 · roles asignados en los perfiles recuperados =="
docker exec "${COPY_CONTAINER}" psql -U postgres -d postgres -tAc "
  select role_key||' ('||count(*)||')' from public.profiles group by role_key order by 1;"

#!/usr/bin/env bash
# Demuestra que el ejecutor de migraciones del repo es HONESTO:
#
#   · una migración que revierte por objeto duplicado queda PENDIENTE,
#   · NO se registra en `schema_migrations` como aplicada,
#   · el error se comunica (el paso falla con código distinto de 0),
#   · y el ejecutor se recupera cuando el conflicto desaparece.
#
# El texto «already exists» por sí solo no acredita que una migración se haya
# completado: la transacción ya revirtió cuando se registró el error.
#
# Este script es efímero: crea una migración de prueba, la borra al terminar.
set -uo pipefail

PROBE_NAME="99999999999999_zz_conflict_probe.sql"
PROBE_PATH="supabase/migrations/${PROBE_NAME}"

cleanup() { rm -f "${PROBE_PATH}"; }
trap cleanup EXIT

cat > "${PROBE_PATH}" <<'SQL'
-- Migración de prueba: el objeto ya existe (lo crea el propio ejecutor),
-- así que la transacción revierte.
create table public.schema_migrations (
  filename text primary key,
  applied_at timestamptz not null default now()
);
SQL

echo "== 1 · db:migrate con una migración que choca con un objeto existente =="
pnpm --filter @crm/api db:migrate > /tmp/migrate-conflict.log 2>&1
code=$?
tail -12 /tmp/migrate-conflict.log

if [ "${code}" -eq 0 ]; then
  echo "FALLO: el ejecutor debe salir con código != 0 cuando una migración revierte."
  exit 1
fi
echo "OK · código de salida = ${code} (distinto de 0)"

if ! grep -q "queda PENDIENTE" /tmp/migrate-conflict.log; then
  echo "FALLO: el ejecutor no comunificó que la migración quedó pendiente."
  exit 1
fi
echo "OK · el ejecutor comunificó que la migración quedó PENDIENTE"

ledger=$(pnpm --filter @crm/api db:exec \
  "select filename from public.schema_migrations where filename = '${PROBE_NAME}'" 2>&1)
if echo "${ledger}" | grep -q "${PROBE_NAME}"; then
  echo "FALLO: la migración revertida quedó registrada como aplicada:"
  echo "${ledger}"
  exit 1
fi
echo "OK · la migración revertida NO está en schema_migrations"

echo
echo "== 2 · sin la migración conflictiva, el ejecutor vuelve a quedar verde =="
rm -f "${PROBE_PATH}"
if ! pnpm --filter @crm/api db:migrate > /tmp/migrate-recover.log 2>&1; then
  echo "FALLO: db:migrate no se recuperó tras desaparecer el conflicto."
  tail -15 /tmp/migrate-recover.log
  exit 1
fi
tail -4 /tmp/migrate-recover.log
echo
echo "OK · el ejecutor de migraciones se comporta como debe."

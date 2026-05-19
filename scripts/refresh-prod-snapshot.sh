#!/usr/bin/env bash
# =============================================================================
# refresh-prod-snapshot.sh
# =============================================================================
# Dumps the Railway production Postgres database and restores it into the
# local pos-preview-postgres container, so the preview backend (NODE_ENV=
# development with .env.development.local) has a recent copy of prod data
# to render against. Intended to run every 6 hours via cron.
#
# pg_dump and pg_restore are run from INSIDE the local container, so the
# Postgres version always matches the local target server (avoids the
# "server version mismatch" error you get with a host pg_dump 16 against
# Railway's prod server 17). The host only needs Docker; no postgres-client
# package required.
#
# Read-only against prod. Drops + recreates the target schema in local DB.
#
# Source DATABASE_URL is read at runtime from backend/.env so the URL is
# never committed and rotation is picked up automatically.
#
# Logs: /tmp/prod-snapshot-YYYY-MM-DD.log
# Exit codes: 0 success, non-zero failure (cron mails owner if configured)
# =============================================================================

set -euo pipefail

BACKEND_DIR="/home/alejo/webapps/ecopowertech-workspace/backend"
ENV_FILE="${BACKEND_DIR}/.env"
CONTAINER="pos-preview-postgres"
LOCAL_DB_URL_IN_CONTAINER="postgres://postgres:preview@127.0.0.1:5432/ecopowertech_preview"
LOG_FILE="/tmp/prod-snapshot-$(date +%F).log"

exec > >(tee -a "${LOG_FILE}") 2>&1

echo "===================================="
echo "Snapshot refresh started: $(date -Iseconds)"
echo "Log: ${LOG_FILE}"
echo "===================================="

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "ERROR: ${ENV_FILE} not found — cannot locate prod DATABASE_URL."
  exit 2
fi

if ! docker inspect "${CONTAINER}" >/dev/null 2>&1; then
  echo "ERROR: container ${CONTAINER} not found. Re-create it before running this script."
  exit 5
fi

if [[ "$(docker inspect -f '{{.State.Running}}' "${CONTAINER}")" != "true" ]]; then
  echo "Container ${CONTAINER} stopped — starting it."
  docker start "${CONTAINER}" >/dev/null
  sleep 3
fi

# Read prod DATABASE_URL without echoing it (the variable holds the secret).
# Bash builtins only — no rtk wrapper grep, no cat to stdout.
PROD_DATABASE_URL=""
while IFS='=' read -r key value; do
  if [[ "${key}" == "DATABASE_URL" ]]; then
    PROD_DATABASE_URL="${value%%#*}"
    PROD_DATABASE_URL="${PROD_DATABASE_URL// /}"
    break
  fi
done < "${ENV_FILE}"

if [[ -z "${PROD_DATABASE_URL}" ]]; then
  echo "ERROR: DATABASE_URL not found in ${ENV_FILE}."
  exit 3
fi

if [[ "${PROD_DATABASE_URL}" == *"127.0.0.1"* ]] || \
   [[ "${PROD_DATABASE_URL}" == *"localhost"* ]]; then
  echo "ERROR: DATABASE_URL in ${ENV_FILE} looks local — refusing to use it as a snapshot source."
  exit 4
fi

# Step 1 — pg_dump from prod, executed inside the local Postgres 17 container
# so the dump format matches the target server. Dump is written to a path
# inside the container; we delete it after restore.
echo "[1/3] pg_dump from prod (running inside ${CONTAINER})..."
docker exec -e PGURL="${PROD_DATABASE_URL}" "${CONTAINER}" \
  pg_dump \
    --format=custom \
    --no-owner \
    --no-privileges \
    --no-comments \
    --file=/tmp/prod.dump \
    "${PROD_DATABASE_URL}"

DUMP_SIZE=$(docker exec "${CONTAINER}" du -h /tmp/prod.dump | cut -f1)
echo "      dump size: ${DUMP_SIZE}"

# Step 2 — drop and recreate the target DB cleanly.
echo "[2/3] reset local DB..."
docker exec "${CONTAINER}" psql -U postgres -d postgres <<'SQL'
DROP DATABASE IF EXISTS ecopowertech_preview WITH (FORCE);
CREATE DATABASE ecopowertech_preview;
SQL

# Step 3 — restore. Parallel jobs speed up large dumps.
echo "[3/3] pg_restore into local..."
docker exec "${CONTAINER}" \
  pg_restore \
    --no-owner \
    --no-privileges \
    --jobs=4 \
    --dbname="${LOCAL_DB_URL_IN_CONTAINER}" \
    /tmp/prod.dump

# Clean up dump file inside the container.
docker exec "${CONTAINER}" rm -f /tmp/prod.dump

echo "Quick row counts:"
docker exec "${CONTAINER}" psql -U postgres -d ecopowertech_preview -A -t <<'SQL'
SELECT 'order: ' || count(*) FROM "order";
SELECT 'product: ' || count(*) FROM product;
SELECT 'customer: ' || count(*) FROM customer;
SQL

echo "===================================="
echo "Snapshot refresh finished: $(date -Iseconds)"
echo "===================================="

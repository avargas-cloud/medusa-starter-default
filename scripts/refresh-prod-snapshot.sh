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

# Step 2 — reset a SIDE (staging) database, then restore into it.
# Why staging instead of restoring straight into ecopowertech_preview:
# the preview Medusa backend (supervised by nodemon) stays connected and
# re-runs its migrations the instant its pool reconnects after a DROP. If we
# restore directly, Medusa races pg_restore and recreates the same enums /
# tables / primary keys concurrently → thousands of "already exists" /
# "multiple primary keys" errors → pg_restore exits non-zero → `set -e`
# aborts the script before the "Snapshot refresh finished:" line is printed,
# which is why the dashboard showed "never". Nobody is connected to the
# staging DB, so its restore is clean; we swap it in at the end.
STAGING_DB="ecopowertech_preview_staging"
STAGING_URL_IN_CONTAINER="postgres://postgres:preview@127.0.0.1:5432/${STAGING_DB}"

echo "[2/4] reset staging DB (${STAGING_DB})..."
# NOTE: `docker exec -i` is REQUIRED — without -i, stdin is not attached and
# the heredoc never reaches psql, so DROP/CREATE silently no-op (this was the
# original "never resets" bug that made every restore land on a populated DB).
docker exec -i "${CONTAINER}" psql -U postgres -d postgres <<SQL
DROP DATABASE IF EXISTS ${STAGING_DB} WITH (FORCE);
CREATE DATABASE ${STAGING_DB};
SQL

# Step 3 — restore into staging. Parallel jobs speed up large dumps.
# pg_restore can exit non-zero on ignorable warnings (extensions, COMMENTS),
# so we capture the code instead of letting `set -e` kill the run, then gate
# the swap on a sanity check below.
echo "[3/4] pg_restore into ${STAGING_DB}..."
set +e
docker exec "${CONTAINER}" \
  pg_restore \
    --no-owner \
    --no-privileges \
    --jobs=4 \
    --dbname="${STAGING_URL_IN_CONTAINER}" \
    /tmp/prod.dump
RESTORE_RC=$?
set -e
if [[ ${RESTORE_RC} -ne 0 ]]; then
  echo "      pg_restore exited ${RESTORE_RC} (tolerating ignorable errors; verifying table count next)"
fi

# Sanity gate — never swap in an obviously broken restore. A healthy prod
# snapshot has 200+ public tables; refuse below a conservative floor and
# leave the current preview DB untouched.
TABLE_COUNT=$(docker exec "${CONTAINER}" psql -U postgres -d "${STAGING_DB}" -A -t \
  -c "SELECT count(*) FROM information_schema.tables WHERE table_schema='public';" | tr -d '[:space:]')
echo "      staging public tables: ${TABLE_COUNT}"
if [[ -z "${TABLE_COUNT}" ]] || [[ "${TABLE_COUNT}" -lt 50 ]]; then
  echo "ERROR: staging restore looks broken (${TABLE_COUNT} tables) — leaving current preview DB intact."
  docker exec "${CONTAINER}" rm -f /tmp/prod.dump
  exit 6
fi

# Step 4 — swap staging in. FORCE-drop the live DB (kicks the backend's
# connections; its pool reconnects to the renamed DB) then rename staging.
# Restore already finished, so there is no writer to race anymore.
echo "[4/4] swap ${STAGING_DB} → ecopowertech_preview..."
docker exec -i "${CONTAINER}" psql -U postgres -d postgres <<SQL
DROP DATABASE IF EXISTS ecopowertech_preview WITH (FORCE);
ALTER DATABASE ${STAGING_DB} RENAME TO ecopowertech_preview;
SQL

# Clean up dump file inside the container.
docker exec "${CONTAINER}" rm -f /tmp/prod.dump

echo "Quick row counts:"
docker exec -i "${CONTAINER}" psql -U postgres -d ecopowertech_preview -A -t <<'SQL'
SELECT 'order: ' || count(*) FROM "order";
SELECT 'product: ' || count(*) FROM product;
SELECT 'customer: ' || count(*) FROM customer;
SQL

echo "===================================="
echo "Snapshot refresh finished: $(date -Iseconds)"
echo "===================================="

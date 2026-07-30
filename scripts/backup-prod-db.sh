#!/usr/bin/env bash
#
# Full backup of the PRODUCTION database, taken before a data migration.
#
# ── Why it runs inside a container ──────────────────────────────────────────
# The host has pg_dump 16.14 and the server is 17.7, so a direct host dump dies
# with "server version mismatch" — the same trap `refresh-prod-snapshot.sh`
# documents. The dump therefore runs inside a postgres:17 container and is
# copied out afterwards.
#
# ── Why it verifies ─────────────────────────────────────────────────────────
# A dump file that exists is not a backup; a dump file that can be READ is. The
# script re-opens the finished archive with `pg_restore --list` and compares the
# row counts of the tables this migration touches against the live database. A
# truncated or half-written dump passes "the file is there" and fails both of
# those.
#
# Read-only against production. Nothing is restored anywhere.
#
#   bash scripts/backup-prod-db.sh
#
set -euo pipefail

BACKEND_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$BACKEND_DIR"

CONTAINER="${BACKUP_CONTAINER:-pos-preview-postgres}"
OUT_DIR="${BACKUP_DIR:-$HOME/db-backups}"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT_FILE="$OUT_DIR/ecopowertech-prod-$STAMP.dump"

PROD_URL="$(grep -E '^DATABASE_URL=' .env | cut -d= -f2-)"
if [[ -z "$PROD_URL" ]]; then
  echo "no DATABASE_URL in backend/.env" >&2
  exit 1
fi

HOST="$(printf '%s' "$PROD_URL" | sed -E 's#.*@([^/:]+).*#\1#')"
if [[ "$HOST" == "localhost" || "$HOST" == "127.0.0.1" ]]; then
  echo "refusing: DATABASE_URL points at $HOST, which is not production." >&2
  echo "This script exists to back up prod; pointing it elsewhere produces a" >&2
  echo "file named like a prod backup that is not one." >&2
  exit 1
fi

if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  echo "refusing: container '$CONTAINER' is not running." >&2
  echo "It supplies pg_dump 17; the host's is 16 and cannot read this server." >&2
  exit 1
fi

mkdir -p "$OUT_DIR"

echo
echo "backing up  $HOST"
echo "        to  $OUT_FILE"
echo

echo "[1/3] pg_dump (inside $CONTAINER)…"
docker exec "$CONTAINER" rm -f /tmp/backup.dump
docker exec "$CONTAINER" pg_dump \
  --format=custom \
  --no-owner \
  --no-privileges \
  --file=/tmp/backup.dump \
  "$PROD_URL"

echo "[2/3] copying out of the container…"
docker cp "$CONTAINER:/tmp/backup.dump" "$OUT_FILE"
docker exec "$CONTAINER" rm -f /tmp/backup.dump
SIZE="$(du -h "$OUT_FILE" | cut -f1)"
echo "      $SIZE"

echo "[3/3] verifying the archive is readable and complete…"
# Readable: pg_restore has to be able to parse the whole table of contents.
TOC_LINES="$(docker run --rm -v "$OUT_DIR:/b" postgres:17-alpine \
  pg_restore --list "/b/$(basename "$OUT_FILE")" | grep -c 'TABLE DATA' || true)"
echo "      $TOC_LINES table(s) with data in the archive"
if [[ "$TOC_LINES" -lt 50 ]]; then
  echo "REFUSING TO CALL THIS A BACKUP: only $TOC_LINES tables carry data." >&2
  exit 1
fi

# Complete: the archive must actually contain the rows this migration will
# touch. Printing the LIVE counts here would look like verification and check
# nothing — the first version of this script did exactly that. The rows are
# counted INSIDE the archive and compared.
FAILED=0
for T in order order_summary order_line_item order_line_item_adjustment pos_invoice; do
  IN_DUMP="$(docker run --rm -v "$OUT_DIR:/b" postgres:17-alpine \
    pg_restore --data-only --table="$T" -f - "/b/$(basename "$OUT_FILE")" 2>/dev/null \
    | awk '/^COPY /{f=1;next} /^\\\.$/{f=0} f' | wc -l)"
  LIVE="$(psql "$PROD_URL" -A -t -c "SELECT count(*) FROM \"$T\";")"
  if [[ "$IN_DUMP" == "$LIVE" ]]; then
    printf '      OK   %-28s %s row(s)\n' "$T" "$IN_DUMP"
  else
    printf '      DIFF %-28s dump=%s live=%s\n' "$T" "$IN_DUMP" "$LIVE"
    FAILED=1
  fi
done
if [[ "$FAILED" == "1" ]]; then
  echo "REFUSING TO CALL THIS A BACKUP: the archive does not hold what prod holds." >&2
  echo "(A row written between the dump and this check explains a difference of a" >&2
  echo " few; a large gap or a zero does not.)" >&2
  exit 1
fi

echo
echo "backup complete: $OUT_FILE"
echo
echo "to restore a single table into a scratch database:"
echo "  pg_restore --data-only --table=order_summary -d <scratch_url> $OUT_FILE"
echo "to restore everything into a fresh database:"
echo "  pg_restore --no-owner --no-privileges -d <fresh_url> $OUT_FILE"
echo

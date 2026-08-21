#!/usr/bin/env bash
#
# run-close-fod39.sh — cierra el ciclo de FOD-39 (PO-1138) en PRODUCCION.
#
# Se corre UNA vez. Hace dos cosas, en orden, y para si la primera falla:
#   1. Sube FOD-39 de draft a submitted y lo recibe por sus 8 lineas / 88
#      unidades ECTSK, fechado con la fecha del PO (2026-08-05). China queda
#      acreditada +88.
#   2. PASO 4+5 de rebuild-skydance-fos: pone TODOS los ECTSK de China en
#      On Hand 0 absoluto y resincroniza MeiliSearch.
#
# Corre DESPRENDIDO (nohup) a proposito: son dos arranques de Medusa seguidos y
# un comando en primer plano se corta a los ~2 minutos, que es exactamente como
# quedo la migracion a medio aplicar mas temprano hoy.
#
# Uso:   bash /home/alejo/webapps/ecopowertech-workspace/backend/scripts/run-close-fod39.sh
# Log:   /tmp/fod39-close.log

set -euo pipefail

BACKEND=/home/alejo/webapps/ecopowertech-workspace/backend
LOG=/tmp/fod39-close.log

cd "$BACKEND"

DB=$(grep '^DATABASE_URL=' .env | cut -d= -f2-)
RD=$(grep '^REDIS_URL=' .env | cut -d= -f2-)

if [ -z "$DB" ]; then
  echo "ABORTA: no pude leer DATABASE_URL de $BACKEND/.env" >&2
  exit 1
fi

nohup bash -c "
set -e
cd '$BACKEND'

echo '=== 1/2 — recibir FOD-39 (PO-1138), fecha del PO ==='
env DISABLE_SCHEDULED_JOBS=true APPLY=true \
    DATABASE_URL='$DB' REDIS_URL='$RD' \
    ./node_modules/.bin/medusa exec ./src/scripts/fix/receive-fod39-po1138.ts

echo
echo '=== 2/2 — PASO 4+5: China a On Hand 0 + reindex MeiliSearch ==='
env DISABLE_SCHEDULED_JOBS=true APPLY=true \
    SKIP_CLEANUP=true SKIP_DELETE=true SKIP_CREATE=true SKIP_DRAFT=true \
    DATABASE_URL='$DB' REDIS_URL='$RD' \
    ./node_modules/.bin/medusa exec ./src/scripts/fix/rebuild-skydance-fos.ts

echo
echo '=== TERMINO OK ==='
" > "$LOG" 2>&1 &

echo "Lanzado en background (PID $!)."
echo "Log: $LOG"
echo "Tarda ~2-3 minutos. No hace falta esperar en esta terminal."

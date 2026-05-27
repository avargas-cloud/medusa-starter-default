#!/bin/bash

# dev-preview.sh — Preview snapshot backend (port 9000, snapshot DB on :5501).
# This is the backend that Cloudflare tunnel medusa.eptbridge.com forwards to,
# used by Vercel preview deploys of store-pos.
# Counterpart: dev.sh runs the Railway-backed dev backend on :9090.
# Wrappers: ../back-preview (this script) · ../back (Railway dev).
#
# Why a separate script: Medusa's loadEnv() does NOT auto-load .env.preview
# (or .env.development.local). We source it explicitly before exec so the
# preview DB URL wins over .env (the unset + set -a; source pattern below
# guarantees the preview values are present in the process environment before
# Medusa's own dotenv pass runs).

set -e

cleanup() {
    echo "🛑 Shutting down..."
    exit
}
trap cleanup SIGINT

export PORT=9000

if [ ! -f .env.preview ]; then
    echo "❌ .env.preview not found in $(pwd)"
    echo "   Expected at backend/.env.preview — copy/derive from .env and point"
    echo "   DATABASE_URL at the snapshot DB (127.0.0.1:5501/ecopowertech_preview)."
    exit 1
fi

echo "🚀 Starting PREVIEW backend on :$PORT (snapshot DB)"
echo "🧪 Loading .env.preview overrides (DATABASE_URL → snapshot, etc.)"

# Wipe potentially stale exports so the source below is deterministic.
unset DATABASE_URL REDIS_URL NODE_ENV
unset QB_BRIDGE_URL QB_API_KEY QB_ORDER_FLOW_ENABLED QB_DRY_RUN QB_INTEGRATION

# Source preview overrides into the process env. `set -a` exports every var
# defined while it's on; `set +a` disables that mode. Anything not set in
# .env.preview falls back to .env (which Medusa loads itself via loadEnv).
set -a
# shellcheck disable=SC1091
source .env.preview
set +a

# Hard guard: refuse to start if DATABASE_URL is still pointing at Railway —
# that would mean .env.preview did not actually override it, and starting in
# this state is the exact bug that motivated this script.
if echo "${DATABASE_URL:-}" | grep -qE "rlwy\.net|railway"; then
    echo "❌ Refusing to start: DATABASE_URL still points at Railway after sourcing .env.preview."
    echo "   Check backend/.env.preview — DATABASE_URL must point at the local snapshot DB."
    exit 1
fi

# Verify the snapshot DB is reachable before launching Medusa.
if ! docker ps --filter "name=pos-preview-postgres" --format '{{.Names}}' | grep -q pos-preview-postgres; then
    echo "❌ Container pos-preview-postgres is not running."
    echo "   Start it before launching the preview backend (see backend/CLAUDE.md → PREVIEW MODE)."
    exit 1
fi

# Clean up any old Medusa processes on :9000
echo "🧹 Cleaning up old Medusa processes on :$PORT..."
pkill -9 -f "medusa develop.*$PORT" 2>/dev/null || true
PORT_PID=$(lsof -ti:$PORT 2>/dev/null || true)
if [ -n "$PORT_PID" ]; then
    echo "   Freeing port $PORT (PID: $PORT_PID)..."
    kill -9 $PORT_PID 2>/dev/null || true
fi
sleep 1

echo "🛍️  Starting Medusa Server (preview)... (QB Bridge: $QB_BRIDGE_URL)"
exec npx nodemon \
  --watch src \
  --watch medusa-config.ts \
  --ignore "*.md" \
  --ignore "dist" \
  --ignore "node_modules" \
  --ext ts,tsx,js,jsx \
  --exec "medusa develop 2>&1 | grep -v 'ECONNRESET\|errno: -104\|syscall.*read\|at TCP.onStreamRead\|at TCP.callbackTrampoline'"

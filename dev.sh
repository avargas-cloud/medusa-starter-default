#!/bin/bash

# dev.sh — Railway dev backend (port 9090, connects to Railway prod DB/Redis).
# Counterpart: dev-preview.sh runs the preview snapshot backend on :9000.
# Wrappers: ../back (this script) · ../back-preview (preview snapshot).

set -e

cleanup() {
    echo "🛑 Shutting down..."
    exit
}
trap cleanup SIGINT

export PORT=9090

# CRITICAL: Wipe any stale shell exports that could shadow .env values.
# Medusa's loadEnv() only loads .env.{staging|production|test} + .env — it does
# NOT load .env.development.local or .env.preview. If a previous shell sourced
# .env.preview, its DATABASE_URL/REDIS_URL/etc. would leak into this process and
# silently override .env. The unset below guarantees .env wins.
unset DATABASE_URL REDIS_URL NODE_ENV
unset QB_BRIDGE_URL QB_API_KEY QB_ORDER_FLOW_ENABLED QB_DRY_RUN QB_INTEGRATION

echo "🚀 Starting Railway dev backend on :$PORT"
echo "📡 Connecting to Railway Postgres + Railway Redis (per .env)"

# Clean up any old Medusa processes (safe - only kills medusa-related)
echo "🧹 Cleaning up old Medusa processes on :$PORT..."
pkill -9 -f "medusa develop.*$PORT" 2>/dev/null || true
PORT_PID=$(lsof -ti:$PORT 2>/dev/null || true)
if [ -n "$PORT_PID" ]; then
    echo "   Freeing port $PORT (PID: $PORT_PID)..."
    kill -9 $PORT_PID 2>/dev/null || true
fi
sleep 1

# Read QB_BRIDGE_URL from .env (Cloudflare URL by default).
QB_BRIDGE_URL="$(grep -m1 '^QB_BRIDGE_URL=' .env 2>/dev/null | cut -d'=' -f2-)"
export QB_BRIDGE_URL="${QB_BRIDGE_URL:-https://qb.eptbridge.com}"

echo "🛍️  Starting Medusa Server... (QB Bridge: $QB_BRIDGE_URL)"
exec npx nodemon \
  --watch src \
  --watch medusa-config.ts \
  --ignore "*.md" \
  --ignore "dist" \
  --ignore "node_modules" \
  --ext ts,tsx,js,jsx \
  --exec "medusa develop 2>&1 | grep -v 'ECONNRESET\|errno: -104\|syscall.*read\|at TCP.onStreamRead\|at TCP.callbackTrampoline'"

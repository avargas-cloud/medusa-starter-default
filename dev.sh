#!/bin/bash

# dev.sh - Development Start Script
# Starts Medusa Server (connects to Railway services)

# Cleanup function to kill background processes on exit
cleanup() {
    echo "🛑 Shutting down..."
    exit
}

# Trap SIGINT (Ctrl+C)
trap cleanup SIGINT

echo "🚀 Starting Development Environment..."

# Clean up any old Medusa processes (safe - only kills medusa-related)
echo "🧹 Cleaning up old Medusa processes..."
pkill -9 -f "medusa develop" 2>/dev/null || true
pkill -9 -f "nodemon.*medusa" 2>/dev/null || true

# Also free port 9000 if anything is using it
PORT_PID=$(lsof -ti:9000 2>/dev/null || true)
if [ ! -z "$PORT_PID" ]; then
    echo "   Freeing port 9000 (PID: $PORT_PID)..."
    kill -9 $PORT_PID 2>/dev/null || true
fi
sleep 1

# Show which database and Redis are configured
DB_LOCAL=false
REDIS_LOCAL=false

if grep -q "localhost:5432" .env 2>/dev/null; then
    DB_LOCAL=true
fi

if grep -q "localhost:6379" .env 2>/dev/null; then
    REDIS_LOCAL=true
fi

if [ "$DB_LOCAL" = true ] && [ "$REDIS_LOCAL" = true ]; then
    echo "🔵 Using LOCAL PostgreSQL + LOCAL Redis"
elif [ "$DB_LOCAL" = true ] && [ "$REDIS_LOCAL" = false ]; then
    echo "🔵 Using LOCAL PostgreSQL + Railway Redis"
elif [ "$DB_LOCAL" = false ] && [ "$REDIS_LOCAL" = true ]; then
    echo "📡 Using RAILWAY PostgreSQL + LOCAL Redis"
else
    echo "📡 Using RAILWAY services (PostgreSQL + Redis)"
fi


# Force QB vars from .env to prevent stale shell exports from overriding them.
# .env is the single source of truth. Falls back to Cloudflare URL if not set.
unset QB_BRIDGE_URL QB_API_KEY QB_ORDER_FLOW_ENABLED QB_DRY_RUN QB_INTEGRATION
QB_BRIDGE_URL="$(grep -m1 '^QB_BRIDGE_URL=' .env 2>/dev/null | cut -d'=' -f2-)"
export QB_BRIDGE_URL="${QB_BRIDGE_URL:-https://qb.eptbridge.com}"

# Start Medusa with explicit nodemon config
echo "🛍️  Starting Medusa Server... (QB Bridge: $QB_BRIDGE_URL)"
exec npx nodemon \
  --watch src \
  --watch medusa-config.ts \
  --ignore "*.md" \
  --ignore "dist" \
  --ignore "node_modules" \
  --ext ts,tsx,js,jsx \
  --exec "medusa develop 2>&1 | grep -v 'ECONNRESET\|errno: -104\|syscall.*read\|at TCP.onStreamRead\|at TCP.callbackTrampoline'"

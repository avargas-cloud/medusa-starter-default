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

# Show which database is configured
if grep -q "localhost:5432" .env 2>/dev/null; then
    echo "🔵 Using LOCAL PostgreSQL + Railway Redis"
elif grep -q "railway.app\|rlwy.net" .env 2>/dev/null; then
    echo "📡 Using RAILWAY services (Postgres + Redis)"
else
    echo "⚠️  Database configuration not detected"
fi


# Start Medusa with explicit nodemon config
echo "🛍️  Starting Medusa Server..."
exec npx nodemon \
  --watch src \
  --watch medusa-config.ts \
  --ignore "*.md" \
  --ignore "dist" \
  --ignore "node_modules" \
  --ext ts,tsx,js,jsx \
  --exec "medusa develop"

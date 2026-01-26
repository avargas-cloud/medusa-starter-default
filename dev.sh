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
echo "📡 Using Railway services (Postgres, Redis, MeiliSearch)"

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

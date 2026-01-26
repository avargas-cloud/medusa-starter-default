#!/bin/bash

# dev.sh - Development Start Script
# Starts local MeiliSearch + Medusa Server

# Cleanup function to kill background processes on exit
cleanup() {
    echo "🛑 Shutting down..."
    if [ -n "$MEILI_PID" ]; then
        kill "$MEILI_PID" 2>/dev/null || true
        echo "✅ MeiliSearch stopped."
    fi
    exit
}

# Trap SIGINT (Ctrl+C)
trap cleanup SIGINT

echo "🚀 Starting Development Environment..."

# 1. Start Local MeiliSearch (if running locally)
# Check if we are in a local environment (e.g., bin/meilisearch exists)
if [ -f "bin/meilisearch" ]; then
    echo "🔍 Starting Local MeiliSearch..."
    ./bin/meilisearch --master-key="masterKey" > /dev/null 2>&1 &
    MEILI_PID=$!
    echo "✅ MeiliSearch running (PID: $MEILI_PID)"
    
    # Wait a moment for it to start
    sleep 2
else
    echo "ℹ️  No local MeiliSearch binary found. Assuming using external service (or Railway)."
fi

# 2. Start Medusa with explicit nodemon config
echo "🛍️  Starting Medusa Server..."
exec npx nodemon \
  --watch src \
  --watch medusa-config.ts \
  --ignore "*.md" \
  --ignore "dist" \
  --ignore "node_modules" \
  --ext ts,tsx,js,jsx \
  --exec "medusa develop"

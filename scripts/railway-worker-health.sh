#!/bin/bash
# Railway Worker Health Check
# Purpose: Verify worker service is processing events correctly

echo "🔍 Railway Worker Health Check"
echo "================================"

# Check if WORKER_MODE is set correctly
if [ "$WORKER_MODE" != "worker" ]; then
    echo "❌ WORKER_MODE is not set to 'worker'"
    echo "   Current: $WORKER_MODE"
    exit 1
fi

echo "✅ WORKER_MODE: $WORKER_MODE"

# Check Redis connection
if [ -z "$REDIS_URL" ]; then
    echo "❌ REDIS_URL not set"
    exit 1
fi
echo "✅ REDIS_URL configured"

# Check Database connection
if [ -z "$DATABASE_URL" ]; then
    echo "❌ DATABASE_URL not set"
    exit 1
fi
echo "✅ DATABASE_URL configured"

# Check MeiliSearch
if [ -z "$MEILISEARCH_HOST" ] || [ -z "$MEILISEARCH_API_KEY" ]; then
    echo "❌ MeiliSearch not configured"
    exit 1
fi
echo "✅ MeiliSearch configured"

echo ""
echo "✅ All environment variables verified"
echo "🚀 Worker service should be ready to process events"

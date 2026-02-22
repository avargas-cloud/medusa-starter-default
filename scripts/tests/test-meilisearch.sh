#!/bin/bash

# Test MeiliSearch Connection and Index Status
# Usage: bash scripts/test-meilisearch.sh

echo "🔍 Testing MeiliSearch Connection..."
echo "======================================"

# Load .env
export $(cat .env | grep -v '^#' | xargs)

echo ""
echo "1. Health Check:"
curl -s "${MEILISEARCH_HOST}/health" | jq '.'

echo ""
echo "2. List Indexes:"
curl -s -H "Authorization: Bearer ${MEILISEARCH_API_KEY}" \
  "${MEILISEARCH_HOST}/indexes" | jq '.results[] | {uid, numberOfDocuments, createdAt}'

echo ""
echo "3. Products Index Stats:"
curl -s -H "Authorization: Bearer ${MEILISEARCH_API_KEY}" \
  "${MEILISEARCH_HOST}/indexes/products/stats" | jq '.'

echo ""
echo "4. Sample Search Test (query: 'LED'):"
curl -s -H "Authorization: Bearer ${MEILISEARCH_API_KEY}" \
  -X POST "${MEILISEARCH_HOST}/indexes/products/search" \
  -H 'Content-Type: application/json' \
  --data '{"q":"LED","limit":3}' | jq '{hits: .hits | length, processingTimeMs, query}'

echo ""
echo "✅ Tests complete!"

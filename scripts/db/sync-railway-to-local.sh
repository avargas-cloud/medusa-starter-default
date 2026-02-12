#!/bin/bash
set -euo pipefail

# Use PostgreSQL 17 tools to match Railway version
PG_DUMP=/usr/lib/postgresql/16/bin/pg_dump
PSQL=/usr/lib/postgresql/16/bin/psql

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
TEMP_DUMP="/tmp/railway_dump_$(date +%Y%m%d_%H%M%S).sql"

echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}  Railway → Local Database Sync${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# Load Railway credentials
if [ ! -f "$BACKEND_DIR/.env.railway" ]; then
    echo -e "${RED}❌ .env.railway not found${NC}"
    exit 1
fi

source "$BACKEND_DIR/.env.railway"
RAILWAY_DB_URL="$DATABASE_URL"

# Load Local credentials
if [ ! -f "$BACKEND_DIR/.env.local" ]; then
    echo -e "${RED}❌ .env.local not found${NC}"
    exit 1
fi

source "$BACKEND_DIR/.env.local"
LOCAL_DB_URL="$DATABASE_URL"

echo -e "${YELLOW}📡 Source:${NC}      Railway (interchange.proxy.rlwy.net:34919)"
echo -e "${YELLOW}🎯 Target:${NC}      Local (localhost:5432/ecopowertech_dev)"
echo -e "${YELLOW}📁 Temp Dump:${NC}   $TEMP_DUMP"
echo ""

# Step 1: Dump Railway database
echo -e "${BLUE}[1/4]${NC} Dumping Railway database..."
if $PG_DUMP "$RAILWAY_DB_URL" > "$TEMP_DUMP" 2>/dev/null; then
    DUMP_SIZE=$(du -h "$TEMP_DUMP" | cut -f1)
    echo -e "${GREEN}      ✅ Railway dump completed ($DUMP_SIZE)${NC}"
else
    echo -e "${RED}      ❌ Failed to dump Railway database${NC}"
    rm -f "$TEMP_DUMP"
    exit 1
fi

# Step 2: Drop and recreate local database
echo -e "${BLUE}[2/4]${NC} Dropping and recreating local database..."

# Extract password from LOCAL_DB_URL
LOCAL_PASSWORD=$(echo "$LOCAL_DB_URL" | grep -oP '://postgres:\K[^@]+')

# Terminate all connections to the database
if PGPASSWORD="$LOCAL_PASSWORD" $PSQL -U postgres -h localhost -d postgres -c \
   "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'ecopowertech_dev' AND pid <> pg_backend_pid();" 2>/dev/null; then
    echo -e "${GREEN}      ✅ Terminated active connections${NC}"
fi

# Drop and recreate database
if PGPASSWORD="$LOCAL_PASSWORD" $PSQL -U postgres -h localhost -c "DROP DATABASE IF EXISTS ecopowertech_dev;" 2>/dev/null &&
   PGPASSWORD="$LOCAL_PASSWORD" $PSQL -U postgres -h localhost -c "CREATE DATABASE ecopowertech_dev;" 2>/dev/null; then
    echo -e "${GREEN}      ✅ Local database recreated${NC}"
else
    echo -e "${RED}      ❌ Failed to recreate local database${NC}"
    rm -f "$TEMP_DUMP"
    exit 1
fi

# Step 3: Restore to local
echo -e "${BLUE}[3/4]${NC} Restoring to local database..."
if $PSQL "$LOCAL_DB_URL" < "$TEMP_DUMP" 2>/dev/null; then
    echo -e "${GREEN}      ✅ Restore completed${NC}"
else
    echo -e "${RED}      ❌ Restore failed${NC}"
    rm -f "$TEMP_DUMP"
    exit 1
fi

# Step 4: Verify and cleanup
echo -e "${BLUE}[4/5]${NC} Verifying sync..."
TABLE_COUNT=$($PSQL "$LOCAL_DB_URL" -t -c "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public';" 2>/dev/null | tr -d ' ')

if [ -n "$TABLE_COUNT" ] && [ "$TABLE_COUNT" -gt 0 ]; then
    echo -e "${GREEN}      ✅ Verification passed ($TABLE_COUNT tables)${NC}"
else
    echo -e "${RED}      ❌ Verification failed${NC}"
    rm -f "$TEMP_DUMP"
    exit 1
fi

# Step 5: Sync Meilisearch indices
echo -e "${BLUE}[5/5]${NC} Syncing Meilisearch indices..."

# Load Meilisearch credentials
source "$BACKEND_DIR/.env.railway"
RAILWAY_MEILI_HOST="$MEILISEARCH_HOST"
RAILWAY_MEILI_KEY="$MEILISEARCH_API_KEY"

source "$BACKEND_DIR/.env.local"
LOCAL_MEILI_HOST="$MEILISEARCH_HOST"
LOCAL_MEILI_KEY="$MEILISEARCH_API_KEY"

# Check if curl and jq are available
if ! command -v curl &> /dev/null || ! command -v jq &> /dev/null; then
    echo -e "${YELLOW}      ⚠️  curl or jq not found, skipping Meilisearch sync${NC}"
    echo -e "${YELLOW}      Install with: sudo apt install curl jq${NC}"
else
    # Export Railway products to temporary file
    MEILI_TEMP="/tmp/meili_products_$(date +%Y%m%d_%H%M%S).json"
    
    # Get all documents from Railway Meilisearch
    if curl -s -X POST "${RAILWAY_MEILI_HOST}/indexes/products/documents/fetch" \
        -H "Authorization: Bearer ${RAILWAY_MEILI_KEY}" \
        -H "Content-Type: application/json" \
        -d '{"limit": 10000}' > "$MEILI_TEMP" 2>/dev/null; then
        
        DOC_COUNT=$(jq '.results | length' "$MEILI_TEMP" 2>/dev/null || echo "0")
        
        if [ "$DOC_COUNT" -gt 0 ]; then
            # Delete all documents from local Meilisearch first
            curl -s -X DELETE "${LOCAL_MEILI_HOST}/indexes/products/documents" \
                -H "Authorization: Bearer ${LOCAL_MEILI_KEY}" > /dev/null 2>&1
            
            sleep 1
            
            # Import to local Meilisearch
            jq '.results' "$MEILI_TEMP" | curl -s -X POST "${LOCAL_MEILI_HOST}/indexes/products/documents" \
                -H "Authorization: Bearer ${LOCAL_MEILI_KEY}" \
                -H "Content-Type: application/json" \
                -d @- > /dev/null 2>&1
            
            echo -e "${GREEN}      ✅ Meilisearch sync completed ($DOC_COUNT products)${NC}"
        else
            echo -e "${YELLOW}      ⚠️  No products found in Railway Meilisearch${NC}"
        fi
        
        rm -f "$MEILI_TEMP"
    else
        echo -e "${YELLOW}      ⚠️  Could not connect to Railway Meilisearch${NC}"
    fi
fi

# Cleanup
rm -f "$TEMP_DUMP"
echo ""
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}✅ Sync complete!${NC} Railway database + Meilisearch copied to local."
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo -e "${YELLOW}💡 Next steps:${NC}"
echo "   1. Switch to local: ./scripts/db/switch-db.sh local"
echo "   2. Restart backend: ./stop-back && ./back"


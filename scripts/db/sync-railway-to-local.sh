#!/bin/bash
set -euo pipefail

# Use PostgreSQL 17 tools to match Railway version
PG_DUMP=/usr/lib/postgresql/17/bin/pg_dump
PSQL=/usr/lib/postgresql/17/bin/psql

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
echo -e "${BLUE}[4/4]${NC} Verifying sync..."
TABLE_COUNT=$($PSQL "$LOCAL_DB_URL" -t -c "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public';" 2>/dev/null | tr -d ' ')

if [ -n "$TABLE_COUNT" ] && [ "$TABLE_COUNT" -gt 0 ]; then
    echo -e "${GREEN}      ✅ Verification passed ($TABLE_COUNT tables)${NC}"
else
    echo -e "${RED}      ❌ Verification failed${NC}"
    rm -f "$TEMP_DUMP"
    exit 1
fi

# Cleanup
rm -f "$TEMP_DUMP"
echo ""
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}✅ Sync complete!${NC} Railway database copied to local."
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo -e "${YELLOW}💡 Next steps:${NC}"
echo "   1. Switch to local: ./scripts/db/switch-db.sh local"
echo "   2. Restart backend: ./stop-back && ./back"

#!/bin/bash
set -euo pipefail

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
TEMP_DUMP="/tmp/local_dump_$(date +%Y%m%d_%H%M%S).sql"

echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${RED}  ⚠️  WARNING: Local → Railway Database Sync${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# Load Local credentials
if [ ! -f "$BACKEND_DIR/.env.local" ]; then
    echo -e "${RED}❌ .env.local not found${NC}"
    exit 1
fi

source "$BACKEND_DIR/.env.local"
LOCAL_DB_URL="$DATABASE_URL"

# Load Railway credentials  
if [ ! -f "$BACKEND_DIR/.env.railway" ]; then
    echo -e "${RED}❌ .env.railway not found${NC}"
    exit 1
fi

source "$BACKEND_DIR/.env.railway"
RAILWAY_DB_URL="$DATABASE_URL"

echo -e "${YELLOW}📡 Source:${NC}      Local (localhost:5432/ecopowertech_dev)"
echo -e "${YELLOW}🎯 Target:${NC}      Railway (interchange.proxy.rlwy.net:34919)"
echo ""
echo -e "${RED}⚠️  THIS WILL OVERWRITE RAILWAY PRODUCTION DATABASE!${NC}"
echo -e "${RED}⚠️  All Railway data will be LOST and replaced with local data.${NC}"
echo ""

# Get table counts
echo -e "${BLUE}Comparing databases...${NC}"
LOCAL_TABLES=$(psql "$LOCAL_DB_URL" -t -c "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public';" 2>/dev/null | tr -d ' ')
RAILWAY_TABLES=$(psql "$RAILWAY_DB_URL" -t -c "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public';" 2>/dev/null | tr -d ' ')

echo -e "  Local tables:   ${GREEN}$LOCAL_TABLES${NC}"
echo -e "  Railway tables: ${YELLOW}$RAILWAY_TABLES${NC}"
echo ""

# First confirmation
echo -e "${YELLOW}Type 'yes' to continue, or anything else to abort:${NC}"
read -r response
if [ "$response" != "yes" ]; then
    echo -e "${GREEN}✅ Aborted. No changes made.${NC}"
    exit 0
fi

# Second confirmation  
echo ""
echo -e "${RED}⚠️  FINAL CONFIRMATION${NC}"
echo -e "${RED}⚠️  Type exactly 'OVERWRITE RAILWAY' to proceed:${NC}"
read -r response
if [ "$response" != "OVERWRITE RAILWAY" ]; then
    echo -e "${GREEN}✅ Aborted. No changes made.${NC}"
    exit 0
fi

echo ""
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${YELLOW}  Proceeding with sync...${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# Step 1: Backup Railway (safety)
RAILWAY_BACKUP="/tmp/railway_backup_$(date +%Y%m%d_%H%M%S).sql"
echo -e "${BLUE}[1/4]${NC} Creating Railway backup (safety)..."
if pg_dump "$RAILWAY_DB_URL" > "$RAILWAY_BACKUP" 2>/dev/null; then
    BACKUP_SIZE=$(du -h "$RAILWAY_BACKUP" | cut -f1)
    echo -e "${GREEN}      ✅ Railway backup saved: $RAILWAY_BACKUP ($BACKUP_SIZE)${NC}"
else
    echo -e "${RED}      ❌ Failed to backup Railway${NC}"
    exit 1
fi

# Step 2: Dump local database
echo -e "${BLUE}[2/4]${NC} Dumping local database..."
if pg_dump "$LOCAL_DB_URL" > "$TEMP_DUMP" 2>/dev/null; then
    DUMP_SIZE=$(du -h "$TEMP_DUMP" | cut -f1)
    echo -e "${GREEN}      ✅ Local dump completed ($DUMP_SIZE)${NC}"
else
    echo -e "${RED}      ❌ Failed to dump local database${NC}"
    rm -f "$TEMP_DUMP"
    exit 1
fi

# Step 3: Drop and recreate Railway database
echo -e "${BLUE}[3/4]${NC} Dropping and recreating Railway database..."
if psql "$RAILWAY_DB_URL" -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;" 2>/dev/null; then
    echo -e "${GREEN}      ✅ Railway database cleared${NC}"
else
    echo -e "${RED}      ❌ Failed to clear Railway database${NC}"
    echo -e "${YELLOW}      💡 You can restore from: $RAILWAY_BACKUP${NC}"
    rm -f "$TEMP_DUMP"
    exit 1
fi

# Step 4: Restore to Railway
echo -e "${BLUE}[4/4]${NC} Restoring to Railway..."
if psql "$RAILWAY_DB_URL" < "$TEMP_DUMP" 2>/dev/null; then
    echo -e "${GREEN}      ✅ Restore completed${NC}"
else
    echo -e "${RED}      ❌ Restore failed${NC}"
    echo -e "${YELLOW}      💡 You can restore from: $RAILWAY_BACKUP${NC}"
    rm -f "$TEMP_DUMP"
    exit 1
fi

# Cleanup temp dump (keep backup)
rm -f "$TEMP_DUMP"

echo ""
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}✅ Sync complete!${NC} Local database copied to Railway."
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo -e "${YELLOW}💡 Railway backup saved at:${NC}"
echo "   $RAILWAY_BACKUP"
echo ""
echo -e "${YELLOW}💡 You can delete the backup manually when no longer needed.${NC}"

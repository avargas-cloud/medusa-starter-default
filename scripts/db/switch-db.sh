#!/bin/bash
set -euo pipefail

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

show_usage() {
    echo "Usage: ./switch-db.sh [local|railway|status]"
    echo ""
    echo "Commands:"
    echo "  local     - Switch to local PostgreSQL + Redis"
    echo "  railway   - Switch to Railway PostgreSQL + Redis"
    echo "  status    - Show current configuration"
    echo ""
    echo "Examples:"
    echo "  ./switch-db.sh local    # Use local database + Redis"
    echo "  ./switch-db.sh railway  # Use Railway database + Redis"
}

show_current_db() {
    if [ ! -f "$BACKEND_DIR/.env" ]; then
        echo -e "${RED}❌ No .env file found${NC}"
        return 1
    fi
    
    DB_URL=$(grep "^DATABASE_URL=" "$BACKEND_DIR/.env" | cut -d'=' -f2-)
    REDIS_URL=$(grep "^REDIS_URL=" "$BACKEND_DIR/.env" | cut -d'=' -f2-)
    MEILI_HOST=$(grep "^MEILISEARCH_HOST=" "$BACKEND_DIR/.env" | cut -d'=' -f2-)
    
    echo -e "${GREEN}Current Database Configuration:${NC}"
    echo ""
    
    # PostgreSQL Info
    if [[ $DB_URL == *"localhost"* ]] || [[ $DB_URL == *"127.0.0.1"* ]]; then
        echo -e "  ${GREEN}PostgreSQL:${NC} LOCAL"
        echo "    Host: localhost"
        echo "    Port: 5432"
        echo "    Database: ecopowertech_dev"
    elif [[ $DB_URL == *"railway"* ]] || [[ $DB_URL == *"rlwy.net"* ]]; then
        echo -e "  ${YELLOW}PostgreSQL:${NC} RAILWAY"
        echo "    Host: interchange.proxy.rlwy.net"
        echo "    Port: 34919"
        echo "    Database: railway"
    else
        echo -e "  ${RED}PostgreSQL:${NC} UNKNOWN"
    fi
    
    echo ""
    
    # Redis Info
    if [[ $REDIS_URL == *"localhost"* ]] || [[ $REDIS_URL == *"127.0.0.1"* ]]; then
        echo -e "  ${GREEN}Redis:${NC} LOCAL"
        echo "    Host: localhost"
        echo "    Port: 6379"
    elif [[ $REDIS_URL == *"railway"* ]] || [[ $REDIS_URL == *"rlwy.net"* ]]; then
        echo -e "  ${YELLOW}Redis:${NC} RAILWAY"
        echo "    Host: centerbeam.proxy.rlwy.net"
        echo "    Port: 56695"
    else
        echo -e "  ${RED}Redis:${NC} UNKNOWN"
    fi
    
    echo ""
    
    # Meilisearch Info
    if [[ $MEILI_HOST == *"localhost"* ]] || [[ $MEILI_HOST == *"127.0.0.1"* ]]; then
        echo -e "  ${GREEN}Meilisearch:${NC} LOCAL"
        echo "    Host: localhost"
        echo "    Port: 7700"
    elif [[ $MEILI_HOST == *"railway"* ]] || [[ $MEILI_HOST == *"meilisearch-production"* ]]; then
        echo -e "  ${YELLOW}Meilisearch:${NC} RAILWAY"
        echo "    Host: meilisearch-production-1237.up.railway.app"
    else
        echo -e "  ${RED}Meilisearch:${NC} UNKNOWN"
    fi
}

switch_to_local() {
    if [ ! -f "$BACKEND_DIR/.env.local" ]; then
        echo -e "${RED}❌ .env.local not found${NC}"
        exit 1
    fi
    
    cp "$BACKEND_DIR/.env.local" "$BACKEND_DIR/.env"
    echo -e "${GREEN}✅ Switched to LOCAL database${NC}"
    echo ""
    show_current_db
    echo ""
    echo -e "${YELLOW}💡 Restart backend server to apply changes:${NC}"
    echo "   ./stop-back && ./back"
}

switch_to_railway() {
    if [ ! -f "$BACKEND_DIR/.env.railway" ]; then
        echo -e "${RED}❌ .env.railway not found${NC}"
        exit 1
    fi
    
    cp "$BACKEND_DIR/.env.railway" "$BACKEND_DIR/.env"
    echo -e "${GREEN}✅ Switched to RAILWAY database${NC}"
    echo ""
    show_current_db
    echo ""
    echo -e "${YELLOW}💡 Restart backend server to apply changes:${NC}"
    echo "   ./stop-back && ./back"
}

# Main logic
case "${1:-}" in
    local)
        switch_to_local
        ;;
    railway)
        switch_to_railway
        ;;
    status)
        show_current_db
        ;;
    *)
        show_usage
        exit 1
        ;;
esac

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
    echo "  local     - Switch to local PostgreSQL database"
    echo "  railway   - Switch to Railway PostgreSQL database"
    echo "  status    - Show current database configuration"
    echo ""
    echo "Examples:"
    echo "  ./switch-db.sh local    # Use local database"
    echo "  ./switch-db.sh railway  # Use Railway database"
}

show_current_db() {
    if [ ! -f "$BACKEND_DIR/.env" ]; then
        echo -e "${RED}❌ No .env file found${NC}"
        return 1
    fi
    
    DB_URL=$(grep "^DATABASE_URL=" "$BACKEND_DIR/.env" | cut -d'=' -f2-)
    
    echo -e "${GREEN}Current Database Configuration:${NC}"
    echo ""
    
    if [[ $DB_URL == *"localhost"* ]] || [[ $DB_URL == *"127.0.0.1"* ]]; then
        echo -e "  Database: ${GREEN}LOCAL PostgreSQL${NC}"
        echo "  Host: localhost"
        echo "  Port: 5432"
        echo "  Database: ecopowertech_dev"
    elif [[ $DB_URL == *"railway"* ]]; then
        echo -e "  Database: ${YELLOW}RAILWAY PostgreSQL${NC}"
        echo "  Host: interchange.proxy.rlwy.net"
        echo "  Port: 34919"
        echo "  Database: railway"
    else
        echo -e "  Database: ${RED}UNKNOWN${NC}"
        echo "  URL: $DB_URL"
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

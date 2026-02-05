#!/bin/bash
# Quick MeiliSearch logs viewer
# Usage: ./show-meili-logs.sh

echo "=== Last 30 lines with [MEILI] tags ==="
echo ""

# Try to read from journalctl if systemd is available
if command -v journalctl &> /dev/null; then
    journalctl -u medusa -n 100 2>/dev/null | grep -i "MEILI" | tail -30
else
    # Fallback: check common log locations
    if [ -f /tmp/medusa.log ]; then
        grep -i "MEILI" /tmp/medusa.log | tail -30
    else
        echo "⚠️  No logs found. Please share a screenshot of your terminal."
        echo ""
        echo "Alternatively, you can manually run:"
        echo "  journalctl -f | grep MEILI"
        echo ""
        echo "Or redirect dev.sh output:"
        echo "  bash dev.sh 2>&1 | tee /tmp/dev.log"
    fi
fi

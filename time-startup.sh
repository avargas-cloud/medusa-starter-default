#!/bin/bash
# Detailed startup timing script

echo "Starting Medusa with detailed timing..."
START_TIME=$(date +%s%N)

# Run medusa with debug output
NODE_OPTIONS="--trace-warnings" medusa develop 2>&1 | while IFS= read -r line; do
    CURRENT_TIME=$(date +%s%N)
    ELAPSED_MS=$(( (CURRENT_TIME - START_TIME) / 1000000 ))
    printf "[%6dms] %s\n" "$ELAPSED_MS" "$line"
done

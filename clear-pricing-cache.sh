#!/bin/bash
# Clear all pricing cache from Redis

docker exec -it ecopowertech-medusa-redis-1 redis-cli --scan --pattern "product:*:prices-stock:*" | xargs -L 1 docker exec -i ecopowertech-medusa-redis-1 redis-cli DEL

echo "✅ Cleared all pricing cache"

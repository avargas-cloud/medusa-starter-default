#!/bin/bash

echo "================================================================================"
echo "🔍 SHIPPING DIAGNOSTIC REPORT"
echo "================================================================================"

# Get a test cart ID first
echo -e "\n📦 Step 1: Creating test cart..."
CART_RESPONSE=$(curl -s -X POST http://localhost:9000/store/carts \
  -H "Content-Type: application/json" \
  -H "x-publishable-api-key: pk_01JHM9MXEDRKPWXNHKWBQCWKFH")

CART_ID=$(echo $CART_RESPONSE | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)

if [ -z "$CART_ID" ]; then
    echo "❌ Failed to create cart"
    exit 1
fi

echo "✅ Cart created: $CART_ID"

# Get shipping options for this cart
echo -e "\n📦 Step 2: Fetching shipping options..."
SHIPPING_OPTIONS=$(curl -s "http://localhost:9000/store/shipping-options?cart_id=$CART_ID" \
  -H "x-publishable-api-key: pk_01JHM9MXEDRKPWXNHKWBQCWKFH")

echo "$SHIPPING_OPTIONS" | jq '.'

# Count options
OPTION_COUNT=$(echo "$SHIPPING_OPTIONS" | jq '.shipping_options | length')
echo -e "\n📊 Found $OPTION_COUNT shipping options"

# Show each option details
echo -e "\n📋 Shipping Options Details:"
echo "================================================================================"
echo "$SHIPPING_OPTIONS" | jq -r '.shipping_options[] | "
Name: \(.name)
ID: \(.id)
Provider: \(.provider_id)
Price Type: \(.price_type)
Amount: \(.amount // "NULL")
Data: \(.data)
---"'

# Get shipping settings
echo -e "\n⚙️  Step 3: Fetching shipping settings..."
SETTINGS=$(curl -s http://localhost:9000/shipping-settings)
echo "$SETTINGS" | jq '.'

echo -e "\n================================================================================"
echo "✅ Diagnostic complete!"
echo "================================================================================"

#!/bin/bash

# Configuration
API_URL="http://localhost:9000"
EMAIL="a.vargas@ecopowertech.com"
PASSWORD="alejovp32145*"

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'

echo "🔍 Starting Verification: Native Address Defaults"

# 1. Login
echo -e "\n1. Logging in..."
LOGIN_RESP=$(curl -s -X POST "$API_URL/auth/customer/emailpass" \
  -H "Content-Type: application/json" \
  -d "{\"email\": \"$EMAIL\", \"password\": \"$PASSWORD\"}")

TOKEN=$(echo $LOGIN_RESP | grep -o '"access_token":"[^"]*' | cut -d'"' -f4)

if [ -z "$TOKEN" ]; then
    echo -e "${RED}❌ Login failed${NC}"
    echo $LOGIN_RESP
    exit 1
fi
echo -e "${GREEN}✅ Login successful${NC}"

# 2. Create Address
echo -e "\n2. Creating address with DEFAULT BILLING flag..."
CREATE_RESP=$(curl -s -X POST "$API_URL/store/customers/me/addresses" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "first_name": "Test",
    "last_name": "Billing",
    "address_1": "Billing St 123",
    "city": "Bogota",
    "country_code": "co",
    "metadata": {
      "nickname": "Oficina",
      "is_default_billing": true
    }
  }')

# Extract IDs
CUS_DEFAULT_BILLING=$(echo $CREATE_RESP | grep -o '"default_billing_address_id":"[^"]*' | cut -d'"' -f4)
NEW_ADDR_ID=$(echo $CREATE_RESP | grep -o '"id":"addr_[^"]*' | head -1 | cut -d'"' -f4)

if [ "$CUS_DEFAULT_BILLING" == "$NEW_ADDR_ID" ]; then
    echo -e "${GREEN}✅ Success: default_billing_address_id matched new address ID${NC}"
else 
    echo -e "${RED}❌ Failure: default_billing_address_id ($CUS_DEFAULT_BILLING) did not match address ID ($NEW_ADDR_ID)${NC}"
    echo "Full Response excerpt:"
    echo $CREATE_RESP | grep -o '"default_billing_address_id":"[^"]*"'
fi

# 3. Update Address (reuse same address)
echo -e "\n3. Updating address with DEFAULT SHIPPING flag..."
UPDATE_RESP=$(curl -s -X POST "$API_URL/store/customers/me/addresses/$NEW_ADDR_ID" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "metadata": {
      "is_default_shipping": true
    }
  }')

CUS_DEFAULT_SHIPPING=$(echo $UPDATE_RESP | grep -o '"default_shipping_address_id":"[^"]*' | cut -d'"' -f4)

if [ "$CUS_DEFAULT_SHIPPING" == "$NEW_ADDR_ID" ]; then
    echo -e "${GREEN}✅ Success: default_shipping_address_id matched updated address ID${NC}"
else 
    echo -e "${RED}❌ Failure: default_shipping_address_id ($CUS_DEFAULT_SHIPPING) did not match address ID ($NEW_ADDR_ID)${NC}"
    echo "Full Response excerpt:"
    echo $UPDATE_RESP | grep -o '"default_shipping_address_id":"[^"]*"'
fi

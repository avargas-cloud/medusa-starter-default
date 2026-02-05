#!/bin/bash

# Manual curl-based test for /store/customers/me/auth-methods

BACKEND="http://localhost:9000"
API_KEY="pk_519e7f66680afc4ab0136ce701a7f6d1e8df2b8fc48a29b7a55616a05cb5b5f3"
EMAIL="a.vargas@ecopowertech.com"
PASS="alejovp32145*"

echo "🧪 Testing /store/customers/me/auth-methods"
echo "============================================================"

# Step 1: Login
echo -e "\n📝 Step 1: Logging in..."
LOGIN_RESPONSE=$(curl -s -X POST "$BACKEND/store/auth/login" \
  -H "Content-Type: application/json" \
  -H "x-publishable-api-key: $API_KEY" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASS\"}")

echo "Response: $LOGIN_RESPONSE"

TOKEN=$(echo $LOGIN_RESPONSE | grep -o '"token":"[^"]*' | sed 's/"token":"//')

if [ -z "$TOKEN" ]; then
    echo "❌ Login failed - no token received"
    exit 1
fi

echo "✅ Token: ${TOKEN:0:20}..."

# Step 2: Call auth-methods endpoint
echo -e "\n📝 Step 2: Getting auth methods..."
AUTH_METHODS=$(curl -s -X GET "$BACKEND/store/customers/me/auth-methods" \
  -H "Authorization: Bearer $TOKEN" \
  -H "x-publishable-api-key: $API_KEY")

echo -e "\n✅ Response:"
echo "$AUTH_METHODS" | python3 -m json.tool 2>/dev/null || echo "$AUTH_METHODS"

echo -e "\n✅ Test complete!"

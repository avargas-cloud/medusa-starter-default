#!/bin/bash
# Get token from database and run full test

API_KEY="pk_519e7f66680afc4ab0136ce701a7f6d1e8df2b8fc48a29b7a55616a05cb5b5f3"
BASE_URL="http://localhost:9000"
EMAIL="a.vargas@ecopowertech.com"
NEW_PASSWORD="TestPass999!"

echo "========================================="
echo "FULL PASSWORD RESET TEST"
echo "========================================="
echo ""

# Get fresh token from database
echo "🔍 Step 1: Getting reset token from database..."
cat > get-db-token.mjs << 'EOFTOKEN'
import postgres from 'postgres'
const sql = postgres(process.env.DATABASE_URL)
const r = await sql`SELECT metadata->>'reset_token' as token FROM customer WHERE email = 'a.vargas@ecopowertech.com'`
console.log(r[0]?.token || "")
await sql.end()
EOFTOKEN

TOKEN=$(node get-db-token.mjs 2>/dev/null)
rm get-db-token.mjs

if [ -z "$TOKEN" ] || [ "$TOKEN" = "null" ]; then
    echo "❌ No reset token found. Requesting new reset..."
    curl -s -X POST "$BASE_URL/store/auth/reset-password" \
      -H "Content-Type: application/json" \
      -H "x-publishable-api-key: $API_KEY" \
      -d "{\"email\":\"$EMAIL\"}" > /dev/null
    
    echo "✅ Reset email sent. Waiting 2 seconds for DB update..."
    sleep 2
    
    # Try again
    cat > get-db-token.mjs << 'EOFTOKEN'
import postgres from 'postgres'
const sql = postgres(process.env.DATABASE_URL)
const r = await sql`SELECT metadata->>'reset_token' as token FROM customer WHERE email = 'a.vargas@ecopowertech.com'`
console.log(r[0]?.token || "")
await sql.end()
EOFTOKEN
    TOKEN=$(node get-db-token.mjs 2>/dev/null)
    rm get-db-token.mjs
fi

if [ -z "$TOKEN" ] || [ "$TOKEN" = "null" ]; then
    echo "❌ ERROR: Could not get reset token from database"
    exit 1
fi

echo "✅ Token retrieved: ${TOKEN:0:20}..."
echo ""

# STEP 2: Confirm password reset
echo "🔐 Step 2: Confirming password reset with new password..."
CONFIRM_RESPONSE=$(curl -s -w "\nHTTP_CODE:%{http_code}" -X POST "$BASE_URL/store/auth/reset-password/confirm" \
  -H "Content-Type: application/json" \
  -H "x-publishable-api-key: $API_KEY" \
  -d "{\"token\":\"$TOKEN\",\"password\":\"$NEW_PASSWORD\"}")

HTTP_CODE=$(echo "$CONFIRM_RESPONSE" | grep "HTTP_CODE" | cut -d: -f2)
BODY=$(echo "$CONFIRM_RESPONSE" | sed '/HTTP_CODE/d')

echo "Response: $BODY"
echo "HTTP Status: $HTTP_CODE"
echo ""

if [ "$HTTP_CODE" != "200" ]; then
    echo "❌ Password reset confirmation FAILED"
    echo "Check server logs for details"
    exit 1
fi

echo "✅ Password reset confirmed!"
echo ""

# STEP 3: Login with new password
echo "🔑 Step 3: Attempting login with new password..."
sleep 1

LOGIN_RESPONSE=$(curl -s -w "\nHTTP_CODE:%{http_code}" -X POST "$BASE_URL/store/auth/emailpass" \
  -H "Content-Type: application/json" \
  -H "x-publishable-api-key: $API_KEY" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$NEW_PASSWORD\"}")

HTTP_CODE=$(echo "$LOGIN_RESPONSE" | grep "HTTP_CODE" | cut -d: -f2)
BODY=$(echo "$LOGIN_RESPONSE" | sed '/HTTP_CODE/d')

echo "Response: $BODY"
echo "HTTP Status: $HTTP_CODE"
echo ""

if [ "$HTTP_CODE" = "200" ]; then
    echo "========================================="
    echo "✅✅✅ SUCCESS! ✅✅✅"
    echo "========================================="
    echo ""
    echo "Password reset flow works PERFECTLY:"
    echo "  1. ✅ Reset request sent"
    echo "  2. ✅ Token generated in DB"
    echo "  3. ✅ Password reset confirmed"
    echo "  4. ✅ Login works with new password"
    echo ""
    echo "The password hash is being stored correctly!"
    exit 0
else
    echo "========================================="
    echo "❌❌❌ FAILED! ❌❌❌"
    echo "========================================="
    echo ""
    echo "Password reset confirmed but login failed."
    echo "This means the password hash is NOT being stored correctly."
    echo ""
    echo "Check server logs above for errors during password reset."
    exit 1
fi

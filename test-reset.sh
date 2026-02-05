#!/bin/bash

# Password Reset Test Script
# Run this from the frontend after clicking the reset link in your email

API_KEY="pk_519e7f66680afc4ab0136ce701a7f6d1e8df2b8fc48a29b7a55616a05cb5b5f3"
BASE_URL="http://localhost:9000"
EMAIL="a.vargas@ecopowertech.com"
NEW_PASSWORD="TestPass999!"

echo "========================================="
echo "PASSWORD RESET TEST"
echo "========================================="
echo ""

# Get token from URL parameter (user provides this)
if [ -z "$1" ]; then
    echo "❌ ERROR: Please provide the reset token from your email"
    echo "Usage: ./test-reset.sh <TOKEN_FROM_EMAIL>"
    echo ""
    echo "Example:"
    echo "  ./test-reset.sh abc123def456..."
    exit 1
fi

TOKEN="$1"

echo "📧 Email: $EMAIL"
echo "🔑 New Password: $NEW_PASSWORD"
echo "🎫 Token: ${TOKEN:0:20}..."
echo ""

# STEP 1: Confirm password reset
echo "=== STEP 1: Confirming Password Reset ==="
CONFIRM_RESPONSE=$(curl -s -w "\nHTTP_CODE:%{http_code}" -X POST "$BASE_URL/store/auth/reset-password/confirm" \
  -H "Content-Type: application/json" \
  -H "x-publishable-api-key: $API_KEY" \
  -d "{\"token\":\"$TOKEN\",\"password\":\"$NEW_PASSWORD\"}")

HTTP_CODE=$(echo "$CONFIRM_RESPONSE" | grep "HTTP_CODE" | cut -d: -f2)
BODY=$(echo "$CONFIRM_RESPONSE" | sed '/HTTP_CODE/d')

echo "Response: $BODY"
echo "Status: $HTTP_CODE"
echo ""

if [ "$HTTP_CODE" != "200" ]; then
    echo "❌ Password reset confirmation FAILED"
    exit 1
fi

echo "✅ Password reset confirmed successfully"
echo ""

# STEP 2: Try to login with new password
echo "=== STEP 2: Testing Login with New Password ==="
LOGIN_RESPONSE=$(curl -s -w "\nHTTP_CODE:%{http_code}" -X POST "$BASE_URL/store/auth/emailpass" \
  -H "Content-Type: application/json" \
  -H "x-publishable-api-key: $API_KEY" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$NEW_PASSWORD\"}")

HTTP_CODE=$(echo "$LOGIN_RESPONSE" | grep "HTTP_CODE" | cut -d: -f2)
BODY=$(echo "$LOGIN_RESPONSE" | sed '/HTTP_CODE/d')

echo "Response: $BODY"
echo "Status: $HTTP_CODE"
echo ""

if [ "$HTTP_CODE" = "200" ]; then
    echo "✅✅✅ SUCCESS! Password reset works correctly! ✅✅✅"
    echo ""
    echo "The login succeeded with the new password."
    echo "Password hash was stored correctly in the database."
    exit 0
else
    echo "❌❌❌ FAILED! Login did not work after reset ❌❌❌"
    echo ""
    echo "The password reset seemed to work but login failed."
    echo "This indicates a problem with password hash storage."
    exit 1
fi

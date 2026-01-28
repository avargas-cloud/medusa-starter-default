#!/bin/bash
# Railway Worker Deployment Checklist
# Run this script to verify your worker is deployed correctly

echo "🔍 Railway Worker Deployment Verification"
echo "=========================================="
echo ""

# Check 1: Environment Variables
echo "✓ Step 1: Verify Environment Variables"
echo "  Go to Railway → Worker Service → Variables"
echo "  Confirm: WORKER_MODE=worker"
echo "  Confirm: All other vars match API service"
read -p "  Press Enter when verified..."
echo ""

# Check 2: Service Status
echo "✓ Step 2: Check Worker Service Status"
echo "  Go to Railway → Worker Service → Deployments"
echo "  Status should be: ✓ Active"
read -p "  Press Enter when verified..."
echo ""

# Check 3: Subscriber Loading
echo "✓ Step 3: Verify Subscribers Loaded"
echo "  Go to Railway → Worker Service → Logs"
echo "  Search for: 'subscriber'"
echo "  You should see logs showing subscribers loaded"
echo "  (NOT 'No subscriber to load')"
read -p "  Press Enter when verified..."
echo ""

# Check 4: Event Processing
echo "✓ Step 4: Test Event Processing"
echo "  1. Open your Medusa Admin"
echo "  2. Edit any product (change title, price, etc)"
echo "  3. Go to Railway → Worker Service → Logs"
echo "  4. Search for: '⚡ EVENTO DETECTADO'"
echo "  You should see the product update event logged"
read -p "  Press Enter when verified..."
echo ""

# Check 5: MeiliSearch Sync
echo "✓ Step 5: Verify MeiliSearch Auto-Sync"
echo "  1. Edit a product in native admin"
echo "  2. Go to Products Advanced (/app/products-advanced)"
echo "  3. The change should appear WITHOUT clicking 'Sync Now'"
read -p "  Press Enter when verified..."
echo ""

echo ""
echo "🎉 All checks passed! Your worker is operational."
echo ""
echo "📊 What happens now:"
echo "  • API Service: Handles HTTP requests, Admin UI"
echo "  • Worker Service: Processes background events, runs subscribers"
echo "  • Products sync automatically when edited"
echo ""

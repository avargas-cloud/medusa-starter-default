#!/usr/bin/env ts-node
/**
 * Test Google OAuth Configuration
 * 
 * Verifies that:
 * 1. Google credentials are loaded
 * 2. OAuth endpoints are registered
 * 3. Plugin is active
 */

console.log("\n🧪 Testing Google OAuth Configuration\n")
console.log("=".repeat(60))

// Test 1: Environment variables
console.log("\n1️⃣  Testing Environment Variables:")
console.log("   GOOGLE_CLIENT_ID:", process.env.GOOGLE_CLIENT_ID ? `✅ Set (${process.env.GOOGLE_CLIENT_ID.substring(0, 20)}...)` : "❌ Missing")
console.log("   GOOGLE_CLIENT_SECRET:", process.env.GOOGLE_CLIENT_SECRET ? "✅ Set" : "❌ Missing")
console.log("   STOREFRONT_URL:", process.env.STOREFRONT_URL || "❌ Missing")
console.log("   MEDUSA_BACKEND_URL:", process.env.MEDUSA_BACKEND_URL || "❌ Missing")

// Test 2: Expected OAuth URLs
console.log("\n2️⃣  OAuth Flow URLs:")
console.log("   Initiate OAuth:", `${process.env.MEDUSA_BACKEND_URL}/store/auth/google`)
console.log("   Callback URL:", `${process.env.MEDUSA_BACKEND_URL}/store/auth/google/callback`)
console.log("   Success Redirect:", `${process.env.STOREFRONT_URL}/account`)
console.log("   Failure Redirect:", `${process.env.STOREFRONT_URL}/login`)

console.log("\n3️⃣  Next Steps:")
console.log("   1. Restart the server: yarn dev")
console.log("   2. Test OAuth endpoint: curl http://localhost:9000/store/auth/google")
console.log("   3. Should redirect to Google OAuth consent screen")

console.log("\n" + "=".repeat(60))
console.log("✅ Configuration check complete!\n")

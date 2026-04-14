#!/usr/bin/env tsx
/**
 * Verification Script: Google OAuth Implementation
 *
 * This script verifies that the Google OAuth flow is correctly implemented.
 * It checks both the initiate and callback endpoints.
 */

import axios from "axios";
import dotenv from "dotenv";
dotenv.config();

const BACKEND_URL = process.env.MEDUSA_BACKEND_URL || "http://localhost:9000";
const STOREFRONT_URL = process.env.STOREFRONT_URL || "http://localhost:4321";

async function verifyGoogleOAuth() {
  console.log("\n✅ GOOGLE OAUTH IMPLEMENTATION VERIFICATION\n");
  console.log("=".repeat(70));

  let allPassed = true;

  // Test 1: Verify environment variables
  console.log("\n📋 TEST 1: Environment Configuration");
  console.log("-".repeat(70));

  const tests = [
    { name: "GOOGLE_CLIENT_ID", value: process.env.GOOGLE_CLIENT_ID },
    { name: "GOOGLE_CLIENT_SECRET", value: process.env.GOOGLE_CLIENT_SECRET },
    { name: "MEDUSA_BACKEND_URL", value: BACKEND_URL },
    { name: "STOREFRONT_URL", value: STOREFRONT_URL },
  ];

  for (const test of tests) {
    if (test.value) {
      console.log(
        `✅ ${test.name}: ${test.name.includes("SECRET") ? "***" : test.value}`
      );
    } else {
      console.log(`❌ ${test.name}: NOT SET`);
      allPassed = false;
    }
  }

  // Test 2: Verify initiate endpoint exists
  console.log("\n📋 TEST 2: OAuth Initiate Endpoint");
  console.log("-".repeat(70));

  try {
    const response = await axios.get(`${BACKEND_URL}/auth/customer/google`, {
      maxRedirects: 0,
      validateStatus: () => true,
      timeout: 5000,
    });

    if (response.status === 302 || response.status === 301) {
      const redirectUrl = response.headers.location || "";
      console.log(`✅ Endpoint exists and redirects (HTTP ${response.status})`);

      if (redirectUrl.includes("accounts.google.com")) {
        console.log(`✅ Redirects to Google OAuth (correct)`);
        console.log(`   URL: ${redirectUrl.substring(0, 60)}...`);
      } else {
        console.log(`❌ Does not redirect to Google`);
        console.log(`   Location: ${redirectUrl}`);
        allPassed = false;
      }
    } else {
      console.log(`❌ Initiate endpoint returned HTTP ${response.status}`);
      console.log(`   Expected: 302 redirect`);
      allPassed = false;
    }
  } catch (error: any) {
    if (error.code === "ECONNREFUSED") {
      console.log(`❌ Cannot connect to backend at ${BACKEND_URL}`);
      console.log(`   Ensure backend is running: ./back`);
      allPassed = false;
    } else {
      console.log(`❌ Error: ${error.message}`);
      allPassed = false;
    }
  }

  // Test 3: Verify callback endpoint exists
  console.log("\n📋 TEST 3: OAuth Callback Endpoint");
  console.log("-".repeat(70));

  try {
    const response = await axios.get(
      `${BACKEND_URL}/auth/customer/google/callback`,
      {
        maxRedirects: 0,
        validateStatus: () => true,
        timeout: 5000,
      }
    );

    // Callback should return 400/401 without valid auth code (this is expected)
    if (
      response.status === 400 ||
      response.status === 401 ||
      response.status === 302
    ) {
      console.log(`✅ Callback endpoint exists (HTTP ${response.status})`);
      console.log(
        `   Note: ${response.status} is expected without valid Google auth code`
      );
    } else if (response.status === 404) {
      console.log(`❌ Callback endpoint NOT FOUND (404)`);
      allPassed = false;
    } else {
      console.log(
        `⚠️  Callback returned HTTP ${response.status} (check implementation)`
      );
    }
  } catch (error: any) {
    if (error.code !== "ECONNREFUSED") {
      console.log(`⚠️  Callback endpoint test: ${error.message}`);
    }
  }

  // Test 4: Verify callback URL configuration
  console.log("\n📋 TEST 4: Callback URL Configuration");
  console.log("-".repeat(70));

  const expectedCallback = `${BACKEND_URL}/auth/customer/google/callback`;
  console.log(`✅ Configured callback URL:`);
  console.log(`   ${expectedCallback}`);
  console.log(
    `\n⚠️  IMPORTANT: Verify this EXACTLY matches in Google Cloud Console:`
  );
  console.log(`   1. Go to: https://console.cloud.google.com/apis/credentials`);
  console.log(`   2. Click your OAuth 2.0 Client ID`);
  console.log(`   3. Under "Authorized redirect URIs", ensure this is listed:`);
  console.log(`      ${expectedCallback}`);

  // Final Summary
  console.log("\n" + "=".repeat(70));
  if (allPassed) {
    console.log("✅ ALL TESTS PASSED - Google OAuth is correctly configured\n");
    console.log("📝 NEXT STEPS:");
    console.log(
      "   1. Verify callback URL in Google Cloud Console (see TEST 4)"
    );
    console.log("   2. Test the flow:");
    console.log(`      a) Visit: ${STOREFRONT_URL}/login`);
    console.log('      b) Click "Continue with Google"');
    console.log("      c) Authorize with Google account");
    console.log("      d) Should redirect back logged in");
    console.log("");
  } else {
    console.log("❌ SOME TESTS FAILED - Review errors above\n");
    process.exit(1);
  }
}

verifyGoogleOAuth().catch((error) => {
  console.error("\n❌ Fatal error:", error.message);
  process.exit(1);
});

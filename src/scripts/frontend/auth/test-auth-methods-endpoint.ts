#!/usr/bin/env npx tsx

import axios from "axios";

const BACKEND_URL = "http://localhost:9000";
const TEST_EMAIL = "a.vargas@ecopowertech.com";
const TEST_PASSWORD = "alejovp32145*";

async function testAuthMethodsEndpoint() {
  console.log("\n🧪 Testing /store/customers/me/auth-methods Endpoint");
  console.log("=".repeat(60));

  try {
    // Step 1: Login using Medusa GOLD STANDARD endpoint
    console.log(
      "\n📝 Step 1: Logging in with Medusa gold standard endpoint..."
    );
    const loginResponse = await axios.post(
      `${BACKEND_URL}/auth/customer/emailpass`,
      {
        email: TEST_EMAIL,
        password: TEST_PASSWORD,
      },
      {
        headers: {
          "Content-Type": "application/json",
        },
      }
    );

    const token = loginResponse.data.token;
    console.log("✅ Logged in successfully");
    console.log(`   Token: ${token.substring(0, 20)}...`);

    // Step 2: Call auth-methods endpoint
    console.log("\n📝 Step 2: Calling /store/customers/me/auth-methods...");
    const authMethodsResponse = await axios.get(
      `${BACKEND_URL}/store/customers/me/auth-methods`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      }
    );

    console.log("\n✅ Response from /store/customers/me/auth-methods:");
    console.log(JSON.stringify(authMethodsResponse.data, null, 2));

    // Step 3: Validate response structure
    console.log("\n📊 Validation:");
    const { providers, has_password, has_google } = authMethodsResponse.data;

    if (!Array.isArray(providers)) {
      throw new Error("providers should be an array");
    }
    if (typeof has_password !== "boolean") {
      throw new Error("has_password should be a boolean");
    }
    if (typeof has_google !== "boolean") {
      throw new Error("has_google should be a boolean");
    }

    console.log(`  ✅ Providers: ${providers.join(", ")}`);
    console.log(`  ✅ Has Password: ${has_password}`);
    console.log(`  ✅ Has Google: ${has_google}`);

    // Step 4: Frontend usage example
    console.log("\n🎨 Frontend Badge Logic:");
    const showGoogleBadge = has_google && !has_password;
    console.log(
      `  Show "Google Account" Badge: ${showGoogleBadge ? "✅ YES" : "❌ NO"}`
    );
    console.log(
      `  Reason: User ${has_google ? "HAS" : "does NOT have"} Google, ${has_password ? "HAS" : "does NOT have"} password`
    );

    console.log("\n✅ ✅ ✅ ALL TESTS PASSED! ✅ ✅ ✅");
    console.log("Endpoint is working correctly!");
  } catch (error: any) {
    console.error("\n❌ Test failed");
    if (error.response) {
      console.error("   Status:", error.response.status);
      console.error("   Data:", JSONstringify(error.response.data, null, 2));
    } else {
      console.error("   Error:", error.message);
    }
    process.exit(1);
  }
}

testAuthMethodsEndpoint();

// Test script to verify 2-step registration returns token with actor_id
import fetch from "node-fetch";

const BACKEND_URL = "http://localhost:9000";
const PUBLISHABLE_KEY =
  "pk_519e7f66680afc4ab0136ce701a7f6d1e8df2b8fc48a29b7a55616a05cb5b5f3";

const testEmail = `verify_2step_${Date.now()}@test.com`;

async function test2StepRegistration() {
  console.log("🧪 Testing 2-Step Registration Flow\n");
  console.log("📧 Test email:", testEmail);
  console.log("🎯 Goal: Verify token has actor_id populated\n");

  try {
    // Call ONLY the backend registration endpoint (2 steps internal)
    console.log("📤 Calling POST /store/auth/register...");

    const response = await fetch(`${BACKEND_URL}/store/auth/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-publishable-api-key": PUBLISHABLE_KEY,
      },
      body: JSON.stringify({
        email: testEmail,
        password: "Test123!",
        first_name: "Verify",
        last_name: "TwoStep",
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error("❌ Registration failed:", data);
      return;
    }

    console.log("\n✅ Registration Response:");
    console.log("   Status:", response.status);
    console.log("   Customer ID:", data.customer?.id);
    console.log("   Token received:", !!data.token);

    if (data.token) {
      // Decode token to check actor_id
      const jwt = await import("jsonwebtoken");
      const decoded = jwt.decode(data.token) as any;

      console.log("\n🔍 Token Payload:");
      console.log(
        JSON.stringify(
          {
            actor_id: decoded?.actor_id,
            actor_type: decoded?.actor_type,
            auth_identity_id: decoded?.auth_identity_id,
            app_metadata: decoded?.app_metadata,
          },
          null,
          2
        )
      );

      if (decoded?.actor_id) {
        console.log("\n✅ SUCCESS: Token has actor_id =", decoded.actor_id);
        console.log("✅ 2-step registration working correctly!");
      } else {
        console.log("\n❌ FAIL: Token actor_id is empty");
        console.log("❌ 2-step registration still broken");
      }

      // Test authenticated request with this token
      console.log("\n🔐 Testing authenticated request...");
      const meResponse = await fetch(`${BACKEND_URL}/store/customers/me`, {
        headers: {
          Authorization: `Bearer ${data.token}`,
          "x-publishable-api-key": PUBLISHABLE_KEY,
        },
      });

      console.log("   GET /store/customers/me:", meResponse.status);

      if (meResponse.ok) {
        const customerData = await meResponse.json();
        console.log("   ✅ Authenticated successfully!");
        console.log("   Customer:", customerData.customer?.email);
      } else {
        console.log("   ❌ Authentication failed (401)");
      }
    }
  } catch (error) {
    console.error("❌ Error:", error);
  }
}

test2StepRegistration();

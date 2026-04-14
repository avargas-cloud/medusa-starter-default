#!/usr/bin/env tsx
import axios from "axios";
import dotenv from "dotenv";
dotenv.config();

const API_URL = "http://localhost:9000";
const EMAIL = "a.vargas@ecopowertech.com";
const PASSWORD = "alejovp32145*";
const PUBLISHABLE_API_KEY = process.env.PUBLISHABLE_API_KEY!;

async function verifyNativeAddresses() {
  console.log("🔍 Testing Native Medusa v2 Address Implementation\n");

  try {
    // 1. Login
    console.log("1️⃣ Logging in...");
    const loginRes = await axios.post(`${API_URL}/auth/customer/emailpass`, {
      email: EMAIL,
      password: PASSWORD,
    });

    console.log("   Login response keys:", Object.keys(loginRes.data));

    const token = loginRes.data.token || loginRes.data.access_token;
    if (!token) {
      throw new Error(
        "No token in response. Keys: " + Object.keys(loginRes.data).join(", ")
      );
    }
    console.log("   ✅ Logged in successfully\n");

    const client = axios.create({
      baseURL: API_URL,
      headers: {
        Authorization: `Bearer ${token}`,
        "x-publishable-api-key": PUBLISHABLE_API_KEY,
      },
    });

    // 2. Create address with is_default_billing = true
    console.log("2️⃣ Creating address with is_default_billing...");
    const createRes = await client.post("/store/customers/me/addresses", {
      first_name: "Test",
      last_name: "User",
      address_1: "123 Test Street",
      city: "Miami",
      country_code: "us",
      postal_code: "33101",
      metadata: {
        nickname: "Test Billing",
        is_default_billing: true,
      },
    });

    const customer1 = createRes.data.customer;
    const newAddr = customer1.addresses.find(
      (a: any) => a.metadata?.nickname === "Test Billing"
    );

    console.log("   Customer Response:");
    console.log(
      `   - default_billing_address_id: ${customer1.default_billing_address_id}`
    );
    console.log(
      `   - default_shipping_address_id: ${customer1.default_shipping_address_id}`
    );
    console.log(`   - New address ID: ${newAddr?.id}`);
    console.log(
      `   - New address is_default_billing: ${newAddr?.is_default_billing}`
    );

    if (
      customer1.default_billing_address_id === newAddr?.id &&
      newAddr?.is_default_billing === true
    ) {
      console.log(
        "   ✅ PASS: default_billing_address_id matches new address\n"
      );
    } else {
      console.log("   ❌ FAIL: default_billing_address_id mismatch\n");
    }

    // 3. Update address to set is_default_shipping = true
    console.log("3️⃣ Updating same address with is_default_shipping...");
    const updateRes = await client.post(
      `/store/customers/me/addresses/${newAddr.id}`,
      {
        metadata: {
          is_default_shipping: true,
        },
      }
    );

    const customer2 = updateRes.data.customer;
    const updatedAddr = customer2.addresses.find(
      (a: any) => a.id === newAddr.id
    );

    console.log("   Customer Response:");
    console.log(
      `   - default_billing_address_id: ${customer2.default_billing_address_id}`
    );
    console.log(
      `   - default_shipping_address_id: ${customer2.default_shipping_address_id}`
    );
    console.log(
      `   - Address is_default_billing: ${updatedAddr?.is_default_billing}`
    );
    console.log(
      `   - Address is_default_shipping: ${updatedAddr?.is_default_shipping}`
    );

    if (
      customer2.default_shipping_address_id === newAddr.id &&
      updatedAddr?.is_default_shipping === true
    ) {
      console.log(
        "   ✅ PASS: default_shipping_address_id matches updated address\n"
      );
    } else {
      console.log("   ❌ FAIL: default_shipping_address_id mismatch\n");
    }

    // 4. Create another address with is_default_billing to test that old one gets unset
    console.log("4️⃣ Creating second address as new default_billing...");
    const create2Res = await client.post("/store/customers/me/addresses", {
      first_name: "Second",
      last_name: "Address",
      address_1: "456 Second St",
      city: "Miami",
      country_code: "us",
      postal_code: "33102",
      metadata: {
        nickname: "Second Billing",
        is_default_billing: true,
      },
    });

    const customer3 = create2Res.data.customer;
    const secondAddr = customer3.addresses.find(
      (a: any) => a.metadata?.nickname === "Second Billing"
    );
    const oldAddr = customer3.addresses.find((a: any) => a.id === newAddr.id);

    console.log("   Customer Response:");
    console.log(
      `   - default_billing_address_id: ${customer3.default_billing_address_id}`
    );
    console.log(`   - Second address ID: ${secondAddr?.id}`);
    console.log(
      `   - Second address is_default_billing: ${secondAddr?.is_default_billing}`
    );
    console.log(
      `   - Old address is_default_billing: ${oldAddr?.is_default_billing}`
    );

    if (
      customer3.default_billing_address_id === secondAddr?.id &&
      secondAddr?.is_default_billing === true &&
      oldAddr?.is_default_billing === false
    ) {
      console.log("   ✅ PASS: Only one address can be default_billing\n");
    } else {
      console.log(
        "   ❌ FAIL: Multiple addresses marked as default or wrong ID\n"
      );
    }

    console.log("🎉 All tests completed!");
  } catch (error: any) {
    console.error("\n❌ Test Failed:");
    console.error("   Message:", error.message);
    if (error.response) {
      console.error("   Status:", error.response.status);
      console.error("   Data:", JSON.stringify(error.response.data, null, 2));
    }
  }
}

verifyNativeAddresses();

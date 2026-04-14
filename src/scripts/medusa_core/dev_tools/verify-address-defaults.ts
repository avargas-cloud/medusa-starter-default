import axios from "axios";

const API_URL = "http://localhost:9000";
const EMAIL = "a.vargas@ecopowertech.com";
const PASSWORD = "alejovp32145*";

async function verify() {
  console.log("🔍 Starting Verification: Native Address Defaults (TS)");

  try {
    // 1. Login
    console.log("\n1. Logging in...");
    const loginRes = await axios.post(`${API_URL}/auth/customer/emailpass`, {
      email: EMAIL,
      password: PASSWORD,
    });

    console.log("Login Response:", JSON.stringify(loginRes.data, null, 2));

    const token = loginRes.data.access_token;
    if (!token) throw new Error("No access token returned");
    console.log("✅ Login successful");

    const client = axios.create({
      baseURL: API_URL,
      headers: { Authorization: `Bearer ${token}` },
    });

    // 2. Create Address
    console.log("\n2. Creating address with DEFAULT BILLING flag...");
    const createRes = await client.post("/store/customers/me/addresses", {
      first_name: "Test",
      last_name: "Billing",
      address_1: "Billing St 123",
      city: "Bogota",
      country_code: "co",
      metadata: {
        nickname: "Oficina TS",
        is_default_billing: true,
      },
    });

    const customer = createRes.data.customer;
    // We expect the new address to be the last one? Or find by nickname
    const newAddress = customer.addresses.find(
      (a: any) => a.metadata?.nickname === "Oficina TS"
    );

    if (!newAddress) {
      throw new Error("❌ Newly created address not found in response");
    }

    if (customer.default_billing_address_id === newAddress.id) {
      console.log(
        "✅ Success: default_billing_address_id matched new address ID"
      );
    } else {
      console.error(
        `❌ Failure: customer.default_billing_address_id (${customer.default_billing_address_id}) !== address.id (${newAddress.id})`
      );
    }

    // 3. Update Address
    console.log("\n3. Updating address with DEFAULT SHIPPING flag...");
    const updateRes = await client.post(
      `/store/customers/me/addresses/${newAddress.id}`,
      {
        metadata: {
          is_default_shipping: true,
        },
      }
    );

    const updatedCustomer = updateRes.data.customer;

    if (updatedCustomer.default_shipping_address_id === newAddress.id) {
      console.log(
        "✅ Success: default_shipping_address_id matched updated address ID"
      );
    } else {
      console.error(
        `❌ Failure: customer.default_shipping_address_id (${updatedCustomer.default_shipping_address_id}) !== address.id (${newAddress.id})`
      );
    }
  } catch (error: any) {
    console.error("❌ Verification Failed:", error.message);
    if (error.response) {
      console.error(
        "Response Data:",
        JSON.stringify(error.response.data, null, 2)
      );
    }
  }
}

verify();

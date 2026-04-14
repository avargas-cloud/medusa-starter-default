#!/usr/bin/env tsx
import axios from "axios";

const API_URL = "http://localhost:9000";
const EMAIL = "a.vargas@ecopowertech.com";
const PASSWORD = "alejovp32145*";

async function testNativeCustomerQuery() {
  try {
    // Login
    const loginRes = await axios.post(`${API_URL}/auth/customer/emailpass`, {
      email: EMAIL,
      password: PASSWORD,
    });

    const token = loginRes.data.token;

    // Get customer using NATIVE Medusa endpoint
    const customerRes = await axios.get(`${API_URL}/store/customers/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    const customer = customerRes.data.customer;

    console.log("📋 Native Medusa Customer Response:");
    console.log(
      JSON.stringify(
        {
          id: customer.id,
          email: customer.email,
          default_billing_address_id: customer.default_billing_address_id,
          default_shipping_address_id: customer.default_shipping_address_id,
          addresses_count: customer.addresses?.length || 0,
        },
        null,
        2
      )
    );

    if (customer.addresses) {
      console.log("\n📍 Addresses:");
      customer.addresses.forEach((addr: any, i: number) => {
        console.log(`   ${i + 1}. ${addr.address_1}`);
        console.log(`      is_default_billing: ${addr.is_default_billing}`);
        console.log(`      is_default_shipping: ${addr.is_default_shipping}`);
      });
    }
  } catch (error: any) {
    console.error("❌ Failed:", error.response?.data || error.message);
  }
}

testNativeCustomerQuery();

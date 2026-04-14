#!/usr/bin/env tsx
import { Client } from "pg";
import dotenv from "dotenv";
dotenv.config();

async function checkCustomerDefaults() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
  });

  try {
    await client.connect();
    console.log("✅ Connected to database\n");

    // 1. Check customer table schema for default address columns
    console.log("📋 Checking customer table schema...");
    const schemaResult = await client.query(`
            SELECT column_name, data_type, is_nullable
            FROM information_schema.columns 
            WHERE table_name = 'customer' 
            AND column_name IN ('default_billing_address_id', 'default_shipping_address_id')
            ORDER BY column_name
        `);

    if (schemaResult.rows.length === 0) {
      console.log(
        "❌ CRITICAL: Columns default_billing_address_id and default_shipping_address_id DO NOT EXIST in customer table!"
      );
      console.log("   You need to run a migration to add these columns.\n");
    } else {
      console.log("✅ Schema columns found:");
      schemaResult.rows.forEach((row) => {
        console.log(
          `   - ${row.column_name} (${row.data_type}, nullable: ${row.is_nullable})`
        );
      });
      console.log("");
    }

    // 2. Get customer with email a.vargas@ecopowertech.com
    const customerResult = await client.query(
      `
            SELECT id, email, default_billing_address_id, default_shipping_address_id
            FROM customer
            WHERE email = $1
        `,
      ["a.vargas@ecopowertech.com"]
    );

    if (customerResult.rows.length === 0) {
      console.log("❌ Customer with email a.vargas@ecopowertech.com not found");
      return;
    }

    const customer = customerResult.rows[0];
    console.log("🧑 Customer Found:");
    console.log(`   ID: ${customer.id}`);
    console.log(`   Email: ${customer.email}`);
    console.log(
      `   default_billing_address_id: ${customer.default_billing_address_id || "NULL ❌"}`
    );
    console.log(
      `   default_shipping_address_id: ${customer.default_shipping_address_id || "NULL ❌"}`
    );
    console.log("");

    // 3. Get all addresses for this customer
    const addressesResult = await client.query(
      `
            SELECT id, address_1, city, metadata
            FROM customer_address
            WHERE customer_id = $1
            ORDER BY created_at DESC
        `,
      [customer.id]
    );

    console.log(
      `📍 Customer Addresses (${addressesResult.rows.length} total):`
    );
    addressesResult.rows.forEach((addr, index) => {
      const isBillingDefault =
        addr.id === customer.default_billing_address_id
          ? "✅ DEFAULT BILLING"
          : "";
      const isShippingDefault =
        addr.id === customer.default_shipping_address_id
          ? "✅ DEFAULT SHIPPING"
          : "";
      const metadataFlags = addr.metadata
        ? `metadata.is_default_billing=${addr.metadata.is_default_billing}, metadata.is_default_shipping=${addr.metadata.is_default_shipping}`
        : "no metadata";

      console.log(`   ${index + 1}. ID: ${addr.id}`);
      console.log(`      Address: ${addr.address_1}, ${addr.city}`);
      console.log(`      ${metadataFlags}`);
      console.log(`      ${isBillingDefault} ${isShippingDefault}`);
      console.log("");
    });

    // 4. Diagnosis
    console.log("🔍 DIAGNOSIS:");
    if (
      !customer.default_billing_address_id &&
      !customer.default_shipping_address_id
    ) {
      console.log(
        "❌ NO default addresses are set on the customer record (both NULL)"
      );
      console.log(
        "   This means the endpoints did NOT update the customer table."
      );
      console.log("   Possible causes:");
      console.log("   1. The columns do not exist (check schema above)");
      console.log("   2. The updateCustomersWorkflow failed silently");
      console.log("   3. The endpoint logic has a bug\n");
    } else {
      console.log("✅ Default addresses ARE set on customer record");
    }
  } catch (error) {
    console.error("❌ Query failed:", error);
    throw error;
  } finally {
    await client.end();
  }
}

checkCustomerDefaults();

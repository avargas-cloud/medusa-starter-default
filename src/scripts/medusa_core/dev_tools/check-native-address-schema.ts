#!/usr/bin/env tsx
import { Client } from "pg";
import dotenv from "dotenv";
dotenv.config();

async function checkNativeAddressSchema() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
  });

  try {
    await client.connect();
    console.log("✅ Connected to database\n");

    // Check customer_address schema
    console.log('📋 customer_address columns with "default" in name:');
    const columns = await client.query(`
            SELECT column_name, data_type, column_default
            FROM information_schema.columns 
            WHERE table_name = 'customer_address'
            AND column_name LIKE '%default%'
            ORDER BY column_name
        `);

    columns.rows.forEach((col) => {
      console.log(
        `   ✅ ${col.column_name} (${col.data_type}, default: ${col.column_default})`
      );
    });
    console.log("");

    // Check constraints
    console.log("🔒 Constraints on customer_address:");
    const constraints = await client.query(`
            SELECT constraint_name, constraint_type
            FROM information_schema.table_constraints 
            WHERE table_name = 'customer_address'
            AND constraint_name LIKE '%default%'
        `);

    constraints.rows.forEach((c) => {
      console.log(`   - ${c.constraint_name} (${c.constraint_type})`);
    });
    console.log("");

    // Check indexes
    console.log('📇 Indexes on customer_address with "default":');
    const indexes = await client.query(`
            SELECT indexname, indexdef
            FROM pg_indexes
            WHERE tablename = 'customer_address'
            AND indexname LIKE '%default%'
        `);

    indexes.rows.forEach((idx) => {
      console.log(`   ✅ ${idx.indexname}`);
      console.log(`      ${idx.indexdef}`);
      console.log("");
    });

    // Get sample data
    const sample = await client.query(`
            SELECT id, address_1, is_default_billing, is_default_shipping, customer_id
            FROM customer_address
            WHERE customer_id = (SELECT id FROM customer WHERE email = 'a.vargas@ecopowertech.com' LIMIT 1)
            LIMIT 5
        `);

    console.log(`📍 Sample addresses for a.vargas@ecopowertech.com:`);
    sample.rows.forEach((addr, i) => {
      console.log(`   ${i + 1}. ${addr.address_1}`);
      console.log(`      is_default_billing: ${addr.is_default_billing}`);
      console.log(`      is_default_shipping: ${addr.is_default_shipping}`);
      console.log("");
    });
  } catch (error: any) {
    console.error("❌ Query failed:", error.message);
  } finally {
    await client.end();
  }
}

checkNativeAddressSchema();

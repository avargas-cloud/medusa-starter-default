#!/usr/bin/env tsx
import { Client } from "pg";
import dotenv from "dotenv";
dotenv.config();

async function showFullCustomerSchema() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
  });

  try {
    await client.connect();
    console.log("✅ Connected to database\n");

    // Get ALL columns from customer table
    console.log("📋 ALL columns in customer table:");
    const columns = await client.query(`
            SELECT column_name, data_type, is_nullable
            FROM information_schema.columns 
            WHERE table_name = 'customer'
            ORDER BY ordinal_position
        `);

    columns.rows.forEach((col, i) => {
      console.log(`   ${i + 1}. ${col.column_name} (${col.data_type})`);
    });
  } catch (error) {
    console.error("❌ Query failed:", error);
    throw error;
  } finally {
    await client.end();
  }
}

showFullCustomerSchema();

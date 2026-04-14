#!/usr/bin/env tsx
import { Client } from "pg";
import dotenv from "dotenv";
dotenv.config();

async function testSavePreservation() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });

  try {
    await client.connect();
    console.log("\n=== Testing Save Preservation ===\n");

    // Get LED Strips category
    const before = await client.query(`
            SELECT 
                name,
                metadata->'filter_config'->'available_filters' as available_before,
                metadata->'filter_config'->'active_filters' as active_before
            FROM product_category
            WHERE handle = 'led-strips'
            LIMIT 1
        `);

    console.log("BEFORE any changes:");
    console.log(
      "available_filters:",
      JSON.parse(before.rows[0].available_before || "[]").length
    );
    console.log(
      "active_filters:",
      JSON.parse(before.rows[0].active_before || "[]").length
    );
  } finally {
    await client.end();
  }
}

testSavePreservation();

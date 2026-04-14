#!/usr/bin/env tsx
import { Client } from "pg";
import dotenv from "dotenv";
dotenv.config();

async function testSaveFlow() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });

  try {
    await client.connect();

    // Get category before
    const before = await client.query(`
            SELECT name, metadata->'filter_config' as filter_config
            FROM product_category
            WHERE handle = 'linear-lighting-accessories'
            LIMIT 1
        `);

    console.log("\n=== BEFORE SAVE ===");
    console.log(
      "available_filters:",
      before.rows[0].filter_config?.available_filters?.length || 0
    );
    console.log(
      "active_filters:",
      before.rows[0].filter_config?.active_filters?.length || 0
    );
  } finally {
    await client.end();
  }
}

testSaveFlow();

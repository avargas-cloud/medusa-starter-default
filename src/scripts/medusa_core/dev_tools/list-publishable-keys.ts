#!/usr/bin/env tsx
import { Client } from "pg";
import dotenv from "dotenv";
dotenv.config();

async function listPublishableKeys() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
  });

  try {
    await client.connect();

    const result = await client.query(`
            SELECT id, created_at
            FROM publishable_api_key
            ORDER BY created_at DESC
            LIMIT 5
        `);

    console.log("📋 Publishable API Keys:");
    result.rows.forEach((row) => {
      console.log(`  • ${row.id} (created: ${row.created_at})`);
    });
  } catch (error: any) {
    console.error("❌ Error:", error.message);
  } finally {
    await client.end();
  }
}

listPublishableKeys();

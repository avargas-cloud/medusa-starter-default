#!/usr/bin/env tsx
import { Client } from "pg";
import dotenv from "dotenv";
dotenv.config();

async function verifyQBTables() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
  });

  try {
    await client.connect();
    console.log("✅ Connected to database\n");

    // Check quickbooks_config table
    const configSchema = await client.query(`
            SELECT column_name, data_type, column_default
            FROM information_schema.columns 
            WHERE table_name = 'quickbooks_config' 
            ORDER BY ordinal_position
        `);

    console.log("📋 quickbooks_config schema:");
    configSchema.rows.forEach((row) => {
      console.log(`  • ${row.column_name} (${row.data_type})`);
    });

    // Check quickbooks_logs table
    const logsSchema = await client.query(`
            SELECT column_name, data_type
            FROM information_schema.columns 
            WHERE table_name = 'quickbooks_logs' 
            ORDER BY ordinal_position
        `);

    console.log("\n📋 quickbooks_logs schema:");
    logsSchema.rows.forEach((row) => {
      console.log(`  • ${row.column_name} (${row.data_type})`);
    });

    // Check default config row
    const configData = await client.query(
      `SELECT * FROM quickbooks_config WHERE id = 'default'`
    );

    console.log("\n📝 Default config:");
    if (configData.rows.length > 0) {
      console.log("  ✅ Default row exists");
      console.log(
        `  • Inventory interval: ${configData.rows[0].inventory_interval_minutes} mins`
      );
      console.log(
        `  • Price interval: ${configData.rows[0].price_interval_minutes} mins`
      );
      console.log(`  • Bridge URL: ${configData.rows[0].bridge_url}`);
    } else {
      console.log("  ❌ No default row found");
    }

    // Check indexes
    const indexes = await client.query(`
            SELECT indexname, indexdef
            FROM pg_indexes
            WHERE tablename IN ('quickbooks_config', 'quickbooks_logs')
            ORDER BY tablename, indexname
        `);

    console.log("\n🔍 Indexes:");
    indexes.rows.forEach((row) => {
      console.log(`  • ${row.indexname}`);
    });

    console.log("\n✅ All QuickBooks tables verified successfully!\n");
  } catch (error) {
    console.error("❌ Verification failed:", error);
    throw error;
  } finally {
    await client.end();
  }
}

verifyQBTables();

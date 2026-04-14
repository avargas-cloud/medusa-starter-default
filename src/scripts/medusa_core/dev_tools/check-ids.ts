#!/usr/bin/env tsx

import { Client } from "pg";

async function checkIDs() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
  });

  try {
    await client.connect();

    // Check a few subcategories of LED Strips
    const result = await client.query(`
            SELECT id, name, handle, parent_category_id
            FROM product_category 
            WHERE parent_category_id = 'pcat_led-strips'
            LIMIT 5
        `);

    console.log("\n📊 LED Strips Subcategories:\n");
    result.rows.forEach((row) => {
      console.log(`Name: ${row.name}`);
      console.log(`  ID: ${row.id}`);
      console.log(`  Handle: ${row.handle}`);
      console.log(
        `  ID type: ${row.id.match(/^pcat_[0-9A-Z]{26}$/i) ? "REAL ID ✅" : "HANDLE ❌"}`
      );
      console.log("");
    });
  } catch (error) {
    console.error("Error:", (error as Error).message);
  } finally {
    await client.end();
  }
}

checkIDs();

#!/usr/bin/env tsx
import { Client } from "pg";
import dotenv from "dotenv";
dotenv.config();

async function checkAttributes() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });

  try {
    await client.connect();

    // Check if products have metadata.attributes
    const result = await client.query(`
            SELECT 
                handle,
                metadata->'attributes' as attrs
            FROM product
            WHERE metadata ? 'attributes'
            LIMIT 5
        `);

    console.log("Products with metadata.attributes:", result.rows.length);
    console.log(JSON.stringify(result.rows, null, 2));

    // Check relational table
    const relationResult = await client.query(`
            SELECT COUNT(*) as count
            FROM product_product_productattributes_attribute_value
        `);

    console.log("\nRelational table count:", relationResult.rows[0].count);

    // Sample from relational table
    const sampleResult = await client.query(`
            SELECT *
            FROM product_product_productattributes_attribute_value
            LIMIT 3
        `);

    console.log("\nSample from relational table:");
    console.log(JSON.stringify(sampleResult.rows, null, 2));
  } finally {
    await client.end();
  }
}

checkAttributes();

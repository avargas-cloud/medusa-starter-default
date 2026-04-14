#!/usr/bin/env tsx

import { Client } from "pg";

async function findCategoryWithProducts() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
  });

  try {
    await client.connect();

    // Find leaf categories with 5-15 products (good for testing)
    const result = await client.query(`
            SELECT 
                cat.id,
                cat.name,
                cat.handle,
                COUNT(DISTINCT child.id) as child_count,
                COUNT(DISTINCT pcp.product_id) as product_count
            FROM product_category cat
            LEFT JOIN product_category child ON child.parent_category_id = cat.id
            LEFT JOIN product_category_product pcp ON pcp.product_category_id = cat.id
            GROUP BY cat.id, cat.name, cat.handle
            HAVING COUNT(DISTINCT child.id) = 0  -- No children (leaf category)
               AND COUNT(DISTINCT pcp.product_id) BETWEEN 5 AND 15
            ORDER BY COUNT(DISTINCT pcp.product_id) ASC
            LIMIT 5
        `);

    console.log("\n📋 Best leaf categories with products for testing:\n");
    result.rows.forEach((row, i) => {
      console.log(`${i + 1}. ${row.name}`);
      console.log(`   ID: ${row.id}`);
      console.log(`   Products: ${row.product_count}`);
      console.log("");
    });

    if (result.rows.length > 0) {
      const selected = result.rows[0];
      console.log(
        `✅ RECOMMENDED: "${selected.name}" (${selected.product_count} products, no children)\n`
      );
    }
  } catch (error) {
    console.error("Error:", (error as Error).message);
  } finally {
    await client.end();
  }
}

findCategoryWithProducts();

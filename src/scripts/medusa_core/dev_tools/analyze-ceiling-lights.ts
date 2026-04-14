#!/usr/bin/env tsx

import { Client } from "pg";

async function analyzeCeilingLights() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
  });

  try {
    await client.connect();

    // Get parent category
    const parent = await client.query(`
            SELECT id, name, handle
            FROM product_category
            WHERE handle = 'ceiling-lights'
        `);

    if (parent.rows.length === 0) {
      console.log("❌ Ceiling Lights not found\n");
      return;
    }

    const parentCat = parent.rows[0];
    console.log("\n📦 Parent Category:");
    console.log(`   Name: ${parentCat.name}`);
    console.log(`   ID: ${parentCat.id}`);

    // Get children
    const children = await client.query(
      `
            SELECT id, name, handle
            FROM product_category
            WHERE parent_category_id = $1
            ORDER BY name
        `,
      [parentCat.id]
    );

    console.log(`\n👶 Children (${children.rows.length}):`);
    children.rows.forEach((child) => {
      console.log(`   - ${child.name} (${child.id})`);
    });

    // Get product counts
    const productCounts = await client.query(
      `
            SELECT 
                pc.id,
                pc.name,
                COUNT(pcp.product_id) as product_count
            FROM product_category pc
            LEFT JOIN product_category_product pcp ON pcp.product_category_id = pc.id
            WHERE pc.id = $1 OR pc.parent_category_id = $1
            GROUP BY pc.id, pc.name
            ORDER BY pc.name
        `,
      [parentCat.id]
    );

    console.log(`\n📊 Product Distribution:`);
    let totalProducts = 0;
    productCounts.rows.forEach((row) => {
      const count = parseInt(row.product_count);
      totalProducts += count;
      console.log(`   ${row.name}: ${count} products`);
    });
    console.log(`   TOTAL: ${totalProducts} products`);

    console.log(`\n📋 Migration Plan:`);
    console.log(
      `   Categories to migrate: ${children.rows.length + 1} (1 parent + ${children.rows.length} children)`
    );
    console.log(`   Total products to update: ${totalProducts}`);
    console.log(`\n✅ Ready to proceed\n`);
  } catch (error) {
    console.error("Error:", (error as Error).message);
  } finally {
    await client.end();
  }
}

analyzeCeilingLights();

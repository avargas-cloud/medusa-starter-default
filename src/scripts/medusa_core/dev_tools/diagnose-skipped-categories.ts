#!/usr/bin/env tsx
import { Client } from "pg";
import dotenv from "dotenv";
dotenv.config();

async function diagnoseSkippedCategories() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });

  try {
    await client.connect();

    // Get categories that would be skipped (no attributes found)
    const categoriesResult = await client.query(`
            SELECT id, name, parent_category_id
            FROM product_category
            WHERE deleted_at IS NULL
            ORDER BY name
        `);

    const allCategories = categoriesResult.rows;

    // Helper to get descendants
    function getDescendants(categoryId: string): string[] {
      const descendants: string[] = [];
      for (const cat of allCategories) {
        if (cat.parent_category_id === categoryId) {
          descendants.push(cat.id);
          descendants.push(...getDescendants(cat.id));
        }
      }
      return descendants;
    }

    const skippedCategories = [];

    for (const category of allCategories) {
      const categoryIdsToScan = [category.id, ...getDescendants(category.id)];

      // Check products in category
      const productsResult = await client.query(
        `
                SELECT COUNT(DISTINCT p.id) as product_count
                FROM product p
                INNER JOIN product_category_product pcp ON p.id = pcp.product_id
                WHERE pcp.product_category_id = ANY($1::text[])
                  AND p.deleted_at IS NULL
            `,
        [categoryIdsToScan]
      );

      const productCount = parseInt(productsResult.rows[0].product_count);

      // Check attributes
      const attributesResult = await client.query(
        `
                SELECT COUNT(DISTINCT av.attribute_key_id) as attr_count
                FROM product_product_productattributes_attribute_value ppav
                INNER JOIN attribute_value av ON ppav.attribute_value_id = av.id
                INNER JOIN product_category_product pcp ON ppav.product_id = pcp.product_id
                WHERE pcp.product_category_id = ANY($1::text[])
                  AND ppav.deleted_at IS NULL
                  AND av.deleted_at IS NULL
            `,
        [categoryIdsToScan]
      );

      const attrCount = parseInt(attributesResult.rows[0].attr_count);

      if (attrCount === 0) {
        skippedCategories.push({
          name: category.name,
          id: category.id,
          product_count: productCount,
          scanning_count: categoryIdsToScan.length,
        });
      }
    }

    console.log(`\n📊 SKIPPED CATEGORIES ANALYSIS\n`);
    console.log(`Total skipped: ${skippedCategories.length}\n`);

    // Group by reason
    const noProducts = skippedCategories.filter((c) => c.product_count === 0);
    const hasProductsNoAttrs = skippedCategories.filter(
      (c) => c.product_count > 0
    );

    console.log(`❌ ${noProducts.length} categories with NO PRODUCTS:`);
    noProducts.slice(0, 10).forEach((c) => {
      console.log(`   - ${c.name} (scanning ${c.scanning_count} categories)`);
    });
    if (noProducts.length > 10) {
      console.log(`   ... and ${noProducts.length - 10} more\n`);
    }

    console.log(
      `\n⚠️  ${hasProductsNoAttrs.length} categories WITH PRODUCTS but NO ATTRIBUTES:`
    );
    hasProductsNoAttrs.forEach((c) => {
      console.log(
        `   - ${c.name} (${c.product_count} products, scanning ${c.scanning_count} categories)`
      );
    });

    // Sample one to investigate
    if (hasProductsNoAttrs.length > 0) {
      const sample = hasProductsNoAttrs[0];
      console.log(`\n🔍 Investigating: ${sample.name}`);

      const sampleProducts = await client.query(
        `
                SELECT p.handle, p.metadata
                FROM product p
                INNER JOIN product_category_product pcp ON p.id = pcp.product_id
                WHERE pcp.product_category_id = $1
                  AND p.deleted_at IS NULL
                LIMIT 3
            `,
        [sample.id]
      );

      console.log(`   Products in this category:`);
      sampleProducts.rows.forEach((p) => {
        console.log(`   - ${p.handle}`);

        // Check if this product has attribute links
        client
          .query(
            `
                    SELECT COUNT(*) as link_count
                    FROM product_product_productattributes_attribute_value
                    WHERE product_id = $1 AND deleted_at IS NULL
                `,
            [p.handle]
          )
          .then((result) => {
            console.log(`     → ${result.rows[0].link_count} attribute links`);
          });
      });
    }
  } finally {
    await client.end();
  }
}

diagnoseSkippedCategories();

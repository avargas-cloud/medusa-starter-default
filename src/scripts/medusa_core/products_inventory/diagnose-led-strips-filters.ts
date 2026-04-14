#!/usr/bin/env tsx
import { Client } from "pg";
import dotenv from "dotenv";
dotenv.config();

async function diagnoseLEDStripsFilters() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });

  try {
    await client.connect();

    // 1. Find LED Strips category
    const categoryResult = await client.query(`
            SELECT id, name, metadata
            FROM product_category
            WHERE name ILIKE '%LED Strips%'
              AND deleted_at IS NULL
        `);

    if (categoryResult.rows.length === 0) {
      console.log("❌ LED Strips category not found");
      return;
    }

    const ledStrips = categoryResult.rows[0];
    console.log(`✅ Found: ${ledStrips.name} (${ledStrips.id})\n`);

    // 2. Get children recursively
    const allCategoriesResult = await client.query(`
            SELECT id, name, parent_category_id
            FROM product_category
            WHERE deleted_at IS NULL
        `);

    const allCategories = allCategoriesResult.rows;

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

    const descendants = getDescendants(ledStrips.id);
    const categoryIdsToScan = [ledStrips.id, ...descendants];

    console.log(
      `📂 Scanning ${categoryIdsToScan.length} categories (self + children)\n`
    );

    // 3. Get products in these categories
    const productsResult = await client.query(
      `
            SELECT DISTINCT p.id, p.handle
            FROM product p
            INNER JOIN product_category_product pcp ON p.id = pcp.product_id
            WHERE pcp.product_category_id = ANY($1::text[])
              AND p.deleted_at IS NULL
            LIMIT 5
        `,
      [categoryIdsToScan]
    );

    console.log(
      `📦 Found ${productsResult.rows.length} products (showing first 5):`
    );
    productsResult.rows.forEach((p) => console.log(`   - ${p.handle}`));
    console.log();

    // 4. Get attributes for these products (CORRECT QUERY)
    const correctAttributesResult = await client.query(
      `
            SELECT DISTINCT av.attribute_key_id, ak.label
            FROM product_product_productattributes_attribute_value ppav
            INNER JOIN attribute_value av ON ppav.attribute_value_id = av.id
            INNER JOIN attribute_key ak ON av.attribute_key_id = ak.id
            INNER JOIN product_category_product pcp ON ppav.product_id = pcp.product_id
            WHERE pcp.product_category_id = ANY($1::text[])
              AND ppav.deleted_at IS NULL
              AND av.deleted_at IS NULL
            ORDER BY ak.label
        `,
      [categoryIdsToScan]
    );

    console.log(
      `✅ CORRECT: Found ${correctAttributesResult.rows.length} unique attributes:`
    );
    correctAttributesResult.rows.slice(0, 10).forEach((a) => {
      console.log(`   - ${a.label} (${a.attribute_key_id})`);
    });
    if (correctAttributesResult.rows.length > 10) {
      console.log(
        `   ... and ${correctAttributesResult.rows.length - 10} more`
      );
    }
    console.log();

    // 5. Check what's in filter_config
    const filterConfig = ledStrips.metadata?.filter_config;
    if (filterConfig?.active_filters) {
      console.log(
        `📝 filter_config has ${filterConfig.active_filters.length} active filters:`
      );

      // Get labels for these
      const activeIds = filterConfig.active_filters.map(
        (f: any) => f.attribute_id
      );
      const labelsResult = await client.query(
        `
                SELECT id, label
                FROM attribute_key
                WHERE id = ANY($1::text[])
            `,
        [activeIds]
      );

      const labelMap = new Map(labelsResult.rows.map((r) => [r.id, r.label]));

      filterConfig.active_filters.slice(0, 10).forEach((f: any) => {
        console.log(
          `   - ${labelMap.get(f.attribute_id) || "UNKNOWN"} (${f.attribute_id})`
        );
      });
      if (filterConfig.active_filters.length > 10) {
        console.log(
          `   ... and ${filterConfig.active_filters.length - 10} more`
        );
      }
    } else {
      console.log("⚠️  No filter_config found in metadata");
    }

    // 6. Compare: are there mismatches?
    if (filterConfig?.active_filters) {
      const activeIds = new Set(
        filterConfig.active_filters.map((f: any) => f.attribute_id)
      );
      const correctIds = new Set(
        correctAttributesResult.rows.map((r) => r.attribute_key_id)
      );

      const inConfigNotInProducts = [...activeIds].filter(
        (id) => !correctIds.has(id)
      );
      const inProductsNotInConfig = [...correctIds].filter(
        (id) => !activeIds.has(id)
      );

      console.log(`\n🔍 MISMATCH ANALYSIS:`);
      console.log(
        `   ❌ In filter_config but NOT in products: ${inConfigNotInProducts.length}`
      );
      if (inConfigNotInProducts.length > 0) {
        const wrongLabelsResult = await client.query(
          `
                    SELECT id, label
                    FROM attribute_key
                    WHERE id = ANY($1::text[])
                    LIMIT 10
                `,
          [inConfigNotInProducts]
        );

        console.log(`      First 10 wrong attributes:`);
        wrongLabelsResult.rows.forEach((r) => {
          console.log(`      - ${r.label} (${r.id})`);
        });
      }

      console.log(
        `   ℹ️  In products but NOT in filter_config: ${inProductsNotInConfig.length}`
      );
    }
  } finally {
    await client.end();
  }
}

diagnoseLEDStripsFilters();

/**
 * Simple SQL script to mark LED Channels products as oversized
 * Based on variant SKU pattern: EAP-*-8S, EAP-*-8W, EAP-*-8B
 *
 * Run: npx tsx src/scripts/sql-mark-oversized.ts
 */

import { MedusaApp } from "@medusajs/framework";

async function main() {
  console.log("[Mark Oversized] Connecting to database...");

  const { query } = await MedusaApp.create();

  console.log(
    "[Mark Oversized] Finding products with LED Channels SKUs (EAP-*-8[SWB])..."
  );

  // SQL to find products with variants matching the pattern
  const sqlQuery = `
        SELECT DISTINCT p.id, p.handle, p.title, v.sku
        FROM product p
        INNER JOIN product_variant v ON v.product_id = p.id
        WHERE v.sku ~ '^EAP-.*-8[SWB]$'
        ORDER BY v.sku;
    `;

  const result = await query.graph({
    entity: "product",
    fields: ["id", "handle", "title"],
    filters: {
      variants: {
        sku: {
          $ilike: "EAP%8_",
        },
      },
    },
  });

  console.log(`Found ${result.data.length} products to update`);

  result.data.forEach((p: any) => {
    console.log(`  - ${p.handle}: ${p.title}`);
  });

  // Update each product
  console.log("\n[Mark Oversized] Updating products...");

  for (const product of result.data) {
    await query.graph({
      entity: "product",
      fields: ["id"],
      filters: { id: product.id },
      data: {
        metadata: { shipping_type: "oversized" },
      },
    });
    console.log(`  ✓ Updated: ${product.handle}`);
  }

  console.log(`\n[Mark Oversized] ✅ Complete!`);
  process.exit(0);
}

main().catch((error) => {
  console.error("[Mark Oversized] Fatal error:", error);
  process.exit(1);
});

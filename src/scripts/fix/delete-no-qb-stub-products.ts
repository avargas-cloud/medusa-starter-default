/**
 * delete-no-qb-stub-products.ts
 *
 * Deletes every product whose single variant has no quickbooks_id in metadata
 * (i.e., stub products created by repair-unlinked-inventory-items.ts that
 * were never matched to an active QB item).
 *
 * Exclusions:
 *   - Service-category SKUs (Assembly-, Expedite-, Installation-, On-Site-, Service-, test-)
 *   - ESP-NFA30W043x / 044x / 046x variants (have QB IDs set)
 *   - Any variant already having quickbooks_id
 *
 * Cascade order:
 *   inventory_level → inventory_item → product_variant_inventory_item
 *   → product_variant_option → product_variant
 *   → product_option_value → product_option → product
 *
 * Usage:
 *   cd backend
 *   yarn ts-node src/scripts/fix/delete-no-qb-stub-products.ts           # dry-run
 *   yarn ts-node src/scripts/fix/delete-no-qb-stub-products.ts --execute # apply
 *
 * After --execute: run  yarn sync:meili  to remove deleted products from MeiliSearch.
 */

import "dotenv/config";
import postgres from "postgres";

const DRY_RUN = !process.argv.includes("--execute");
const DATABASE_URL = process.env.DATABASE_URL!;

if (!DATABASE_URL) {
  console.error("DATABASE_URL not set");
  process.exit(1);
}

const sql = postgres(DATABASE_URL, { max: 1 });

const EXCLUDED_SKUS = [
  "ESP-NFA30W0430",
  "ESP-NFA30W0440",
  "ESP-NFA30W0460",
];

async function run() {
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(
    "  Delete No-QB Stub Products" + (DRY_RUN ? "  [DRY-RUN]" : "  [EXECUTE]")
  );
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

  // Identify target variants (no quickbooks_id, not service SKUs, not excluded)
  const targets = await sql<
    { product_id: string; variant_id: string; sku: string; inventory_item_id: string | null }[]
  >`
    SELECT
      p.id   AS product_id,
      pv.id  AS variant_id,
      pv.sku AS sku,
      pvii.inventory_item_id
    FROM product_variant pv
    JOIN product p ON p.id = pv.product_id AND p.deleted_at IS NULL
    LEFT JOIN product_variant_inventory_item pvii ON pvii.variant_id = pv.id
    WHERE pv.deleted_at IS NULL
      AND (pv.metadata IS NULL
           OR pv.metadata->>'quickbooks_id' IS NULL
           OR pv.metadata->>'quickbooks_id' = '')
      AND pv.sku IS NOT NULL
      AND pv.sku NOT ILIKE 'test-%'
      AND pv.sku NOT ILIKE 'Assembly-%'
      AND pv.sku NOT ILIKE 'Expedite-%'
      AND pv.sku NOT ILIKE 'Installation-%'
      AND pv.sku NOT ILIKE 'On-Site-%'
      AND pv.sku NOT ILIKE 'Service-%'
      AND pv.sku NOT IN (${sql.array(EXCLUDED_SKUS)})
    ORDER BY pv.sku
  `;

  if (targets.length === 0) {
    console.log("✅  No stub products to delete.");
    await sql.end();
    return;
  }

  const productIds = [...new Set(targets.map((t) => t.product_id))];
  const variantIds = targets.map((t) => t.variant_id);
  const inventoryItemIds = targets
    .map((t) => t.inventory_item_id)
    .filter((id): id is string => id !== null);

  console.log(`Products to delete   : ${productIds.length}`);
  console.log(`Variants             : ${variantIds.length}`);
  console.log(`Inventory items      : ${inventoryItemIds.length}\n`);

  console.log("── SKU list ───────────────────────────────────────────────");
  for (const t of targets) {
    console.log(`  ${t.sku}`);
  }
  console.log();

  if (DRY_RUN) {
    console.log("⚠️   DRY-RUN — no changes made. Pass --execute to apply.");
    console.log("\nAfter applying, run:  yarn sync:meili");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
    await sql.end();
    return;
  }

  // ── CASCADE DELETE ──────────────────────────────────────────────────────────

  await sql.begin(async (tx) => {
    // 1. inventory_level rows for these inventory items
    if (inventoryItemIds.length > 0) {
      const il = await tx`
        DELETE FROM inventory_level
        WHERE inventory_item_id = ANY(${sql.array(inventoryItemIds)})
        RETURNING id
      `;
      console.log(`  Deleted inventory_level rows : ${il.length}`);

      // 2. inventory_item rows themselves
      const ii = await tx`
        DELETE FROM inventory_item
        WHERE id = ANY(${sql.array(inventoryItemIds)})
        RETURNING id
      `;
      console.log(`  Deleted inventory_item rows  : ${ii.length}`);
    }

    // 3. product_variant_inventory_item links
    const pvii = await tx`
      DELETE FROM product_variant_inventory_item
      WHERE variant_id = ANY(${sql.array(variantIds)})
      RETURNING id
    `;
    console.log(`  Deleted pvii rows            : ${pvii.length}`);

    // 4. product_variant_option links
    const pvo = await tx`
      DELETE FROM product_variant_option
      WHERE variant_id = ANY(${sql.array(variantIds)})
      RETURNING variant_id
    `;
    console.log(`  Deleted variant_option rows  : ${pvo.length}`);

    // 5. product_variant rows
    const pv = await tx`
      DELETE FROM product_variant
      WHERE id = ANY(${sql.array(variantIds)})
      RETURNING id
    `;
    console.log(`  Deleted product_variant rows : ${pv.length}`);

    // 6. product_option_value rows (belong to these products' options)
    const optValDel = await tx`
      DELETE FROM product_option_value
      WHERE option_id IN (
        SELECT id FROM product_option WHERE product_id = ANY(${sql.array(productIds)})
      )
      RETURNING id
    `;
    console.log(`  Deleted option_value rows    : ${optValDel.length}`);

    // 7. product_option rows
    const optDel = await tx`
      DELETE FROM product_option
      WHERE product_id = ANY(${sql.array(productIds)})
      RETURNING id
    `;
    console.log(`  Deleted product_option rows  : ${optDel.length}`);

    // 8. product rows
    const prodDel = await tx`
      DELETE FROM product
      WHERE id = ANY(${sql.array(productIds)})
      RETURNING id
    `;
    console.log(`  Deleted product rows         : ${prodDel.length}`);
  });

  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`✅  Deleted ${productIds.length} stub product(s) and all related data.`);
  console.log("\nNext: run  yarn sync:meili  to remove them from MeiliSearch.");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

  await sql.end();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

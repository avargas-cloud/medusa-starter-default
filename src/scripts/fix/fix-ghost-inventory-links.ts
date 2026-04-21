/**
 * fix-ghost-inventory-links.ts
 *
 * Deletes orphaned rows from product_variant_inventory_item where the
 * variant_id no longer exists in product_variant.
 *
 * These "ghost links" cause the POS EditItemModal to fall back to the first
 * variant of the product (incorrect data shown to the admin).
 *
 * Root cause: Medusa deleted/recreated variants but left the old pvii rows.
 *
 * Usage:
 *   cd backend
 *   yarn ts-node src/scripts/fix/fix-ghost-inventory-links.ts           # dry-run
 *   yarn ts-node src/scripts/fix/fix-ghost-inventory-links.ts --execute # apply
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

async function run() {
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  Fix Ghost Inventory Links" + (DRY_RUN ? "  [DRY-RUN]" : "  [EXECUTE]"));
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

  const ghosts = await sql<
    { pvii_id: string; dead_variant_id: string; inventory_item_id: string; sku: string }[]
  >`
    SELECT
      pvii.id              AS pvii_id,
      pvii.variant_id      AS dead_variant_id,
      pvii.inventory_item_id,
      ii.sku
    FROM product_variant_inventory_item pvii
    JOIN inventory_item ii ON ii.id = pvii.inventory_item_id
    LEFT JOIN product_variant pv ON pv.id = pvii.variant_id
    WHERE pv.id IS NULL
    ORDER BY ii.sku
  `;

  if (ghosts.length === 0) {
    console.log("✅  No ghost links found — data is clean.");
    await sql.end();
    return;
  }

  console.log(`Found ${ghosts.length} ghost link(s) to delete:\n`);
  for (const g of ghosts) {
    console.log(
      `  SKU: ${g.sku.padEnd(28)}` +
        ` | pvii_id: ${g.pvii_id}` +
        ` | dead_variant_id: ${g.dead_variant_id}`
    );
  }
  console.log();

  if (DRY_RUN) {
    console.log("⚠️   DRY-RUN — no changes made. Pass --execute to apply.");
    await sql.end();
    return;
  }

  const pviiIds = ghosts.map((g) => g.pvii_id);
  const deleted = await sql`
    DELETE FROM product_variant_inventory_item
    WHERE id = ANY(${sql.array(pviiIds)})
    RETURNING id
  `;

  console.log(`✅  Deleted ${deleted.length} ghost pvii row(s).`);
  console.log(
    "\nNote: The affected inventory items are now unlinked from any variant."
  );
  console.log(
    "Run repair-unlinked-inventory-items.ts to re-link or create stub products."
  );

  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
  await sql.end();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

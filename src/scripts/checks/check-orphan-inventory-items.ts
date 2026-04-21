import { ExecArgs } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/utils";
import { Client } from "pg";

/**
 * check-orphan-inventory-items.ts
 *
 * Detects inventory items that are linked (via product_variant_inventory_item)
 * to a variant_id that no longer exists in product_variant.
 *
 * Root cause: when Medusa deletes or recreates a variant it may leave behind
 * orphaned rows in product_variant_inventory_item pointing to non-existent
 * variant_ids.  These orphans make the POS Edit-Item modal fall back to the
 * first variant of the product — showing the wrong data to the admin.
 *
 * Usage:
 *   npx medusa exec ./src/scripts/checks/check-orphan-inventory-items.ts
 */

export default async function checkOrphanInventoryItems({
  container,
}: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);

  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();

  logger.info("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  logger.info("  Orphan Inventory-Item Detector");
  logger.info("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

  // ── 1. Orphaned product_variant_inventory_item links ────────────────────
  // Rows in the join table whose variant_id does NOT exist in product_variant.
  const orphanLinksResult = await db.query(`
    SELECT
      pvii.variant_id        AS ghost_variant_id,
      pvii.inventory_item_id,
      ii.sku                 AS inventory_sku,
      ii.id                  AS inventory_item_id_confirm
    FROM product_variant_inventory_item pvii
    JOIN  inventory_item    ii  ON  ii.id  = pvii.inventory_item_id
    LEFT JOIN product_variant pv ON pv.id  = pvii.variant_id
    WHERE pv.id IS NULL
    ORDER BY ii.sku
  `);

  const orphanLinks = orphanLinksResult.rows as {
    ghost_variant_id: string;
    inventory_item_id: string;
    inventory_sku: string;
    inventory_item_id_confirm: string;
  }[];

  if (orphanLinks.length === 0) {
    logger.info("✅  No orphaned inventory-item links found. Data is clean.");
  } else {
    logger.warn(
      `⚠️   Found ${orphanLinks.length} orphaned link(s) — inventory items linked to non-existent variants:\n`
    );
    orphanLinks.forEach((row, i) => {
      logger.warn(
        `  ${i + 1}. SKU: ${row.inventory_sku.padEnd(30)} ` +
          `| ghost_variant_id: ${row.ghost_variant_id} ` +
          `| inventory_item: ${row.inventory_item_id}`
      );
    });
  }

  // ── 2. Inventory items with NO variant link at all ──────────────────────
  // Items that exist in inventory_item but have zero rows in
  // product_variant_inventory_item — completely unlinked from the catalog.
  const unlinkedResult = await db.query(`
    SELECT
      ii.sku,
      ii.id AS inventory_item_id
    FROM inventory_item ii
    WHERE NOT EXISTS (
      SELECT 1
      FROM product_variant_inventory_item pvii
      WHERE pvii.inventory_item_id = ii.id
    )
    ORDER BY ii.sku
  `);

  const unlinked = unlinkedResult.rows as {
    sku: string;
    inventory_item_id: string;
  }[];

  logger.info("");
  if (unlinked.length === 0) {
    logger.info(
      "✅  No completely-unlinked inventory items found."
    );
  } else {
    logger.warn(
      `⚠️   Found ${unlinked.length} inventory item(s) with NO variant link at all:\n`
    );
    unlinked.forEach((row, i) => {
      logger.warn(
        `  ${i + 1}. SKU: ${row.sku.padEnd(30)} | inventory_item: ${row.inventory_item_id}`
      );
    });
  }

  // ── 3. Variants with NO inventory item link ─────────────────────────────
  // product_variant rows that are not linked to any inventory item — these
  // will show 0 stock everywhere and can't be restocked properly.
  const variantsWithoutInvResult = await db.query(`
    SELECT
      pv.sku,
      pv.id   AS variant_id,
      p.title AS product_title,
      p.id    AS product_id
    FROM product_variant pv
    JOIN product p ON p.id = pv.product_id
    WHERE NOT EXISTS (
      SELECT 1
      FROM product_variant_inventory_item pvii
      WHERE pvii.variant_id = pv.id
    )
    ORDER BY p.title, pv.sku
  `);

  const variantsWithoutInv = variantsWithoutInvResult.rows as {
    sku: string;
    variant_id: string;
    product_title: string;
    product_id: string;
  }[];

  logger.info("");
  if (variantsWithoutInv.length === 0) {
    logger.info(
      "✅  All product variants have at least one inventory item linked."
    );
  } else {
    logger.warn(
      `⚠️   Found ${variantsWithoutInv.length} variant(s) with NO inventory item link:\n`
    );
    variantsWithoutInv.forEach((row, i) => {
      logger.warn(
        `  ${i + 1}. SKU: ${(row.sku ?? "(no sku)").padEnd(30)} ` +
          `| product: ${row.product_title.substring(0, 35).padEnd(35)} ` +
          `| variant_id: ${row.variant_id}`
      );
    });
  }

  // ── Summary ─────────────────────────────────────────────────────────────
  logger.info("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  const totalIssues =
    orphanLinks.length + unlinked.length + variantsWithoutInv.length;
  if (totalIssues === 0) {
    logger.info("🎉  All checks passed — inventory links are healthy.");
  } else {
    logger.warn(
      `🔧  Total issues: ${totalIssues}  ` +
        `(${orphanLinks.length} ghost links, ` +
        `${unlinked.length} unlinked inv-items, ` +
        `${variantsWithoutInv.length} variants without inv-item)`
    );
    logger.info(
      "\nTo fix ghost links, find or recreate the missing product_variant rows\n" +
        "and ensure product_variant_inventory_item is updated accordingly.\n" +
        "The POS Edit-Item modal falls back to variant[0] when ghost links exist."
    );
  }
  logger.info("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
  await db.end();
}

/**
 * Backfill product.taxable=false for service-type products.
 *
 * Heuristic: a product is treated as a "service" (non-taxable) when NONE of
 * its variants have an entry in product_variant_inventory_item — i.e. it
 * doesn't track physical stock. This matches the catalog reality where
 * INSTALL, Services:Assembly-Panels, Services:Installation-On-Site, etc.
 * are non-stocked items.
 *
 * Default for all OTHER products is taxable=true (preserved by the column
 * default; this script only flips services to false).
 *
 * Run (sandbox first!):
 *   yarn medusa exec ./src/scripts/sync/backfill-taxable-services.ts
 *
 * Optional flag: pass `--dry-run` (or env DRY_RUN=true) to print the list
 * of products that WOULD be flipped without writing anything.
 */
import type { ExecArgs } from "@medusajs/framework/types";

export default async function backfillTaxableServices({ container }: ExecArgs) {
  const logger = container.resolve("logger");
  const pg = container.resolve("__pg_connection__") as any;

  const dryRun =
    process.env.DRY_RUN === "true" || process.argv.includes("--dry-run");

  // Find products where no variant has an inventory_item link.
  //   product
  //     LEFT JOIN product_variant
  //     LEFT JOIN product_variant_inventory_item
  //   GROUP BY product
  //   HAVING (no inventory items) AND (at least 1 variant)
  //
  // The `variants > 0` guard excludes broken catalog rows that have neither
  // variants NOR inventory items — those are likely incomplete physical
  // products (e.g. SKY RF receivers missing their default variant), not
  // services. Marking them non-taxable would be a silent bug if the catalog
  // is later repaired and they ship as physical goods.
  const candidatesRes = await pg.raw(`
    SELECT p.id, p.handle, p.title, p.taxable, COUNT(DISTINCT pv.id) AS variant_count
      FROM product p
      LEFT JOIN product_variant pv ON pv.product_id = p.id AND pv.deleted_at IS NULL
      LEFT JOIN product_variant_inventory_item pvi ON pvi.variant_id = pv.id
     WHERE p.deleted_at IS NULL
     GROUP BY p.id, p.handle, p.title, p.taxable
    HAVING COUNT(pvi.inventory_item_id) = 0
       AND COUNT(DISTINCT pv.id) > 0
  `);

  const candidates = (candidatesRes.rows ?? []) as Array<{
    id: string;
    handle: string;
    title: string;
    taxable: boolean;
    variant_count: string;
  }>;

  logger.info(
    `\n${"=".repeat(70)}\n` +
      `Backfill taxable=false for service products (no inventory items)\n` +
      `${"=".repeat(70)}`
  );
  logger.info(`Found ${candidates.length} candidate product(s).`);

  // Filter to only those that aren't already non-taxable.
  const toFlip = candidates.filter((c) => c.taxable !== false);
  const alreadyFlipped = candidates.length - toFlip.length;

  logger.info(`  Already non-taxable: ${alreadyFlipped}`);
  logger.info(`  Will be flipped:     ${toFlip.length}`);

  if (toFlip.length === 0) {
    logger.info("\nNothing to do — all service products already non-taxable.");
    return;
  }

  // Print the first 30 + total remaining for visibility.
  const sample = toFlip.slice(0, 30);
  logger.info("\nSample of products to flip:");
  for (const p of sample) {
    logger.info(
      `  • ${p.id}  ${p.handle.padEnd(40)}  variants=${p.variant_count}  "${p.title}"`
    );
  }
  if (toFlip.length > 30) {
    logger.info(`  …and ${toFlip.length - 30} more.`);
  }

  if (dryRun) {
    logger.info("\n[DRY RUN] No changes written. Re-run without --dry-run to apply.");
    return;
  }

  // Single batched UPDATE for atomicity.
  const ids = toFlip.map((p) => p.id);
  const r = await pg.raw(
    `UPDATE product SET taxable = false WHERE id = ANY(?::text[])`,
    [ids]
  );

  logger.info(`\n✅ UPDATED ${r.rowCount ?? toFlip.length} product(s) → taxable=false`);
  logger.info(
    "   Note: this only affects the catalog flag. Existing order_line_item /\n" +
      "   pos_invoice_item / pos_credit_memo_item rows are NOT retroactively\n" +
      "   updated — they preserve the snapshot they had at INSERT time. New\n" +
      "   line items going forward will inherit the new flag via triggers."
  );
}

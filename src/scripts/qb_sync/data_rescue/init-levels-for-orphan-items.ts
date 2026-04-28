import { ExecArgs } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, Modules } from "@medusajs/utils";

/**
 * init-levels-for-orphan-items.ts
 *
 * One-shot: initializes inventory_levels (qty=0) at every stock location
 * for inventory_items that currently have ZERO levels. Used after
 * fix-missing-inventory-links.ts created items without levels.
 *
 * Usage:
 *   npx medusa exec src/scripts/qb_sync/data_rescue/init-levels-for-orphan-items.ts          (dry-run)
 *   npx medusa exec src/scripts/qb_sync/data_rescue/init-levels-for-orphan-items.ts -- --run (apply)
 */
export default async function initLevelsForOrphanItems({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const query = container.resolve(ContainerRegistrationKeys.QUERY);
  const inventoryService = container.resolve(Modules.INVENTORY);
  const stockLocationService = container.resolve(Modules.STOCK_LOCATION);

  const DRY_RUN = !process.argv.includes("--run");

  logger.info("=".repeat(65));
  logger.info("📍 Init Levels for Orphan Inventory Items" + (DRY_RUN ? "  [DRY RUN]" : "  [LIVE]"));
  logger.info("=".repeat(65));

  const stockLocations = await stockLocationService.listStockLocations({});
  if (stockLocations.length === 0) {
    logger.error("❌ No stock locations found.");
    return;
  }
  logger.info(`📍 Stock locations: ${stockLocations.map((l: any) => l.name).join(", ")}`);

  // Restricted to the 5 SKUs created by fix-missing-inventory-links.ts on 2026-04-27
  const TARGET_SKUS = new Set([
    "SUP-FC2R4N70W0840",
    "SUP-FC2R4N70W0860",
    "ESP-SFA50W0830",
    "ESP-SFA50W0840",
    "ESP-SFA50W0860",
  ]);

  const { data: items } = await query.graph({
    entity: "inventory_item",
    fields: ["id", "sku", "location_levels.id", "location_levels.location_id"],
    filters: { sku: Array.from(TARGET_SKUS) } as any,
  });

  const orphans = (items as any[]).filter((it) => !it.location_levels || it.location_levels.length === 0);
  logger.info(`\n🔎 Inventory items with zero levels: ${orphans.length}`);

  if (orphans.length === 0) {
    logger.info("✅ Nothing to fix.");
    return;
  }

  orphans.forEach((it: any) => logger.info(`   ${it.sku || "(no sku)"}  ${it.id}`));

  if (DRY_RUN) {
    logger.info("\n💡 Dry-run complete. Run with -- --run to apply.");
    return;
  }

  let fixed = 0;
  let errors = 0;
  for (const item of orphans) {
    try {
      await inventoryService.createInventoryLevels(
        stockLocations.map((loc: any) => ({
          inventory_item_id: item.id,
          location_id: loc.id,
          stocked_quantity: 0,
        })),
      );
      fixed++;
      logger.info(`   ✅ ${item.sku || item.id}  (${stockLocations.length} levels)`);
    } catch (err: any) {
      errors++;
      logger.error(`   ❌ ${item.sku || item.id}: ${err.message}`);
    }
  }

  logger.info("\n" + "=".repeat(65));
  logger.info(`Levels initialized: ${fixed}   errors: ${errors}`);
  logger.info("=".repeat(65));
}

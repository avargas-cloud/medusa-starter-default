import { ExecArgs } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, Modules } from "@medusajs/utils";
import { IInventoryService, IStockLocationService } from "@medusajs/types";
import { Client } from "pg";

/**
 * Snapshot of current Medusa inventory state — run BEFORE doing an inventory sync.
 *
 * Usage:
 *   npx medusa exec src/scripts/verify/verify-inventory-before-sync.ts
 *
 * Shows:
 *  - How many variants have a QB ID linked
 *  - How many have inventory items
 *  - Top 20 SKUs by current stock
 *  - SKUs with stock = 0 (already depleted)
 *  - SKUs with no inventory item linked
 */
export default async function verifyInventoryBeforeSync({
  container,
}: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const inventoryService: IInventoryService = container.resolve(
    Modules.INVENTORY
  );
  const stockLocationService: IStockLocationService = container.resolve(
    Modules.STOCK_LOCATION
  );
  const query = container.resolve(ContainerRegistrationKeys.QUERY);

  logger.info("=".repeat(60));
  logger.info("📦 INVENTORY VERIFICATION SNAPSHOT");
  logger.info("=".repeat(60));

  // Get stock location
  const locations = await stockLocationService.listStockLocations(
    {},
    { take: 1 }
  );
  if (!locations.length) {
    logger.error("❌ No Stock Location found!");
    return;
  }
  const locationId = locations[0].id;
  logger.info(`📍 Location: ${locations[0].name} (${locationId})`);
  logger.info("");

  // Fetch variants
  const { data: variants } = await query.graph({
    entity: "variant",
    fields: [
      "id",
      "sku",
      "title",
      "metadata",
      "inventory_items.inventory_item_id",
    ],
  });

  const qbVariants = variants.filter((v: any) => v.metadata?.quickbooks_id);
  const withInventory = qbVariants.filter(
    (v: any) => v.inventory_items?.[0]?.inventory_item_id
  );
  const noInventory = qbVariants.filter(
    (v: any) => !v.inventory_items?.[0]?.inventory_item_id
  );

  logger.info(`📊 Total variants in Medusa:     ${variants.length}`);
  logger.info(`🔗 Linked to QuickBooks (QB ID): ${qbVariants.length}`);
  logger.info(`📦 Have inventory items:          ${withInventory.length}`);
  logger.info(`⚠️  No inventory item linked:     ${noInventory.length}`);
  logger.info("");

  // Fetch current stock levels for all linked variants
  const stockData: Array<{ sku: string; stock: number }> = [];

  let zeroStock = 0;
  let positiveStock = 0;
  let noLevel = 0;

  for (const variant of withInventory) {
    const inventoryItemId = variant.inventory_items[0].inventory_item_id;
    const levels = await inventoryService.listInventoryLevels({
      inventory_item_id: inventoryItemId,
      location_id: locationId,
    });

    const stock = levels[0]?.stocked_quantity ?? null;

    if (stock === null) {
      noLevel++;
      continue;
    }
    if (stock === 0) zeroStock++;
    else positiveStock++;

    stockData.push({ sku: variant.sku || variant.id, stock });
  }

  logger.info(`📈 Stock Distribution:`);
  logger.info(`   > 0 (in stock):     ${positiveStock}`);
  logger.info(`   = 0 (out of stock): ${zeroStock}`);
  logger.info(`   No level record:    ${noLevel}`);
  logger.info("");

  // Top 20 by stock
  const top20 = stockData.sort((a, b) => b.stock - a.stock).slice(0, 20);
  logger.info("🏆 TOP 20 SKUs by current stock:");
  logger.info("-".repeat(40));
  top20.forEach(({ sku, stock }, i) => {
    const bar = "█".repeat(Math.min(Math.floor(stock / 5), 20));
    logger.info(
      `   ${String(i + 1).padStart(2)}. ${sku.padEnd(20)} ${String(stock).padStart(5)} ${bar}`
    );
  });
  logger.info("");

  // SKUs with 0 stock
  const zeroSkus = stockData.filter((d) => d.stock === 0).map((d) => d.sku);
  if (zeroSkus.length > 0) {
    logger.info(`🔴 SKUs currently at 0 stock (${zeroSkus.length}):`);
    zeroSkus.slice(0, 15).forEach((sku) => logger.info(`   • ${sku}`));
    if (zeroSkus.length > 15)
      logger.info(`   ... and ${zeroSkus.length - 15} more`);
    logger.info("");
  }

  // SKUs missing inventory item
  if (noInventory.length > 0) {
    logger.info(
      `⚠️  SKUs missing inventory item (${noInventory.length}) — these will be SKIPPED by the sync:`
    );
    noInventory.slice(0, 10).forEach((v: any) => logger.info(`   • ${v.sku}`));
    if (noInventory.length > 10)
      logger.info(`   ... and ${noInventory.length - 10} more`);
    logger.info("");
    logger.info(
      "   ➡️  Run 'enable-inventory-management' to fix these before syncing."
    );
  }

  logger.info("=".repeat(60));
  logger.info("✅ Snapshot complete — run dry-run-inventory-sync.ts next");
  logger.info("=".repeat(60));
}

import { ExecArgs } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, Modules } from "@medusajs/utils";
import { IStockLocationService } from "@medusajs/types";
import { applyBulkInventorySync } from "../../../lib/apply-bulk-inventory-sync";

// Config
const BRIDGE_URL = "https://qb.eptbridge.com";
const API_KEY = "mQb-7k9Pzx4RwN2vL8jT3bY6hF5nC1aD";
const POLL_INTERVAL_MS = 30000; // 30 seconds
const MAX_POLL_ATTEMPTS = 20; // 10 minutes max

/**
 * Sync ONLY STOCK from QuickBooks
 * Run: yarn medusa exec ./src/scripts/sync-qb-stock.ts
 * Schedule: Frequently (e.g. every 15-30 mins)
 */
export default async function syncQbStock({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const stockLocationService: IStockLocationService = container.resolve(
    Modules.STOCK_LOCATION
  );
  const query = container.resolve(ContainerRegistrationKeys.QUERY);

  logger.info(`📦 Starting QuickBooks STOCK Sync (ONLY)...`);

  // 1. Get Default Stock Location
  const locations = await stockLocationService.listStockLocations(
    {},
    { take: 1 }
  );

  if (locations.length === 0) {
    logger.error(
      "❌ No Stock Location found! Create one in Medusa Settings first."
    );
    return;
  }
  const locationId = locations[0].id;
  logger.info(`📍 Using Stock Location: ${locations[0].name} (${locationId})`);

  // 2. Fetch Medusa Products with QB ID
  logger.info("🔍 Fetching Medusa Products with QuickBooks ID...");
  const { data: variants } = await query.graph({
    entity: "variant",
    fields: ["id", "sku", "metadata", "inventory_items.inventory_item_id"],
  });

  const qbVariants = variants.filter((v: any) => v.metadata?.quickbooks_id);
  logger.info(`📊 Found ${qbVariants.length} variants linked to QuickBooks.`);

  if (qbVariants.length === 0) {
    logger.info(
      "⚠️ No linked products found. Run 'assign-quickbooks-ids' first."
    );
    return;
  }

  // 3. Initiate Bulk Sync
  logger.info("📡 Requesting Bulk Data from Bridge...");
  const initRes = await fetch(`${BRIDGE_URL}/api/products`, {
    headers: { "x-api-key": API_KEY },
  });

  if (!initRes.ok) {
    logger.error(`❌ Bridge Error: ${initRes.status} ${initRes.statusText}`);
    return;
  }

  const initJson: any = await initRes.json();
  const operationId = initJson.operationId;
  logger.info(`✅ Operation Queued! ID: ${operationId}`);

  // 4. Polling Loop
  let qbData: any[] = [];
  let attempts = 0;

  while (attempts < MAX_POLL_ATTEMPTS) {
    attempts++;
    logger.info(`⏳ Polling Status (${attempts}/${MAX_POLL_ATTEMPTS})...`);

    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

    const statusRes = await fetch(
      `${BRIDGE_URL}/api/sync/status/${operationId}`,
      {
        headers: { "x-api-key": API_KEY },
      }
    );

    if (!statusRes.ok) {
      logger.warn(`   Bridge Status Error: ${statusRes.status}`);
      continue;
    }

    const statusJson: any = await statusRes.json();

    if (statusJson.success && statusJson.operation) {
      if (statusJson.operation.status === "completed") {
        qbData = statusJson.data || [];
        logger.info(
          `✅ Data Received! ${qbData.length} items from QuickBooks.`
        );
        break;
      }

      if (statusJson.operation.status === "failed") {
        logger.error(
          `❌ QB sync failed: ${statusJson.operation.error || "Unknown"}`
        );
        return;
      }
    }
  }

  if (qbData.length === 0) {
    logger.error("❌ No data received after polling timeout.");
    return;
  }

  // 5. Build sync item list from QB data
  logger.info("\n📦 Building stock sync list from QB data...");
  let missingInQb = 0;
  let skippedNoInventory = 0;
  const syncItems: Array<{
    inventory_item_id: string;
    variant_id: string;
    sku: string;
    product_title: string;
    qty_new: number;
  }> = [];

  const qbMap = new Map(qbData.map((item: any) => [item.ListID, item]));

  for (const variant of qbVariants) {
    const qbId = (variant.metadata as any)?.quickbooks_id;
    const qbItem = qbMap.get(qbId);
    if (!qbItem) { missingInQb++; continue; }

    const qty_new = parseInt(qbItem.QuantityOnHand);
    if (isNaN(qty_new)) { logger.warn(`   ⚠️ ${variant.sku}: Invalid stock in QB`); continue; }

    const inventory_item_id = variant.inventory_items?.[0]?.inventory_item_id;
    if (!inventory_item_id) { skippedNoInventory++; continue; }

    syncItems.push({
      inventory_item_id,
      variant_id: variant.id,
      sku: variant.sku,
      product_title: (variant as any).title || variant.sku,
      qty_new,
    });
  }

  // 6. Apply via inventory count module (creates audit trail, skips QB re-enqueue)
  const syncResult = await applyBulkInventorySync(container, {
    items: syncItems,
    memo: `QB Stock Sync ${new Date().toISOString().slice(0, 10)}`,
    location_id: locationId,
    source: "qb_sync",
  });

  logger.info(`\n${"=".repeat(50)}`);
  logger.info("✅ STOCK SYNC SUMMARY");
  logger.info(`${"=".repeat(50)}`);
  logger.info(`Total Linked Variants: ${qbVariants.length}`);
  logger.info(`Found in QB:           ${qbVariants.length - missingInQb}`);
  logger.info(`Missing in QB:         ${missingInQb}`);
  logger.info(`Skipped (No Inv):      ${skippedNoInventory}`);
  logger.info(`Skipped (Unchanged):   ${syncResult.skipped_no_change}`);
  logger.info(`Applied:               ${syncResult.applied}`);
  logger.info(`Blocked:               ${syncResult.blocked}`);
  logger.info(`Prior counts voided:   ${syncResult.voided_prior_counts}`);
  if (syncResult.count_id) logger.info(`Audit count:           ${syncResult.count_id}`);
  logger.info(`${"=".repeat(50)}\n`);
}

import { ExecArgs } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, Modules } from "@medusajs/utils";
import { cancelOpenCountsForItems } from "../../../lib/cancel-open-counts-for-items";
// Fix: Use IInventoryService instead of Internal
import {
  IProductModuleService,
  IPricingModuleService,
  IInventoryService,
  IStockLocationService,
} from "@medusajs/types";

// Config
const BRIDGE_URL = "https://qb.eptbridge.com";
const API_KEY = "mQb-7k9Pzx4RwN2vL8jT3bY6hF5nC1aD";
const POLL_INTERVAL_MS = 30000; // 30 seconds
const MAX_POLL_ATTEMPTS = 20; // 10 minutes max

export default async function syncQbInventory({ container, args }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const knex = container.resolve(ContainerRegistrationKeys.PG_CONNECTION);
  const productModule: IProductModuleService = container.resolve(
    Modules.PRODUCT
  );
  const pricingModule: IPricingModuleService = container.resolve(
    Modules.PRICING
  );
  const inventoryService: IInventoryService = container.resolve(
    Modules.INVENTORY
  );
  const stockLocationService: IStockLocationService = container.resolve(
    Modules.STOCK_LOCATION
  );
  const query = container.resolve(ContainerRegistrationKeys.QUERY);

  // Fix: Handle CLI args or Env Var
  const isDryRun = args.includes("--dry-run") || process.env.DRY_RUN === "true";

  logger.info(`🚀 Starting QuickBooks "Big Sync" (Dry Run: ${isDryRun})...`);

  // 1. Get Default Stock Location
  // listStockLocations returns an array, NOT [array, count]
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
    fields: [
      "id",
      "sku",
      "title",
      "metadata",
      "price_set.id",
      "inventory_items.inventory_item_id",
    ],
    filters: {
      // We can't filter by metadata easily in graph yet, fetch larger set and filter JS side or use specific metadata filter if supported
    },
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
    logger.info(
      `⏳ Polling Status (${attempts}/${MAX_POLL_ATTEMPTS})... Waiting for Web Connector sync loop (every 2 mins)...`
    );

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
        // Bridge returned raw XML?
        const rawXml = statusJson.operation.qbxmlResponse;
        if (rawXml) {
          logger.info("📦 Received Raw XML. Parsing...");
          // Simple Regex Parser for QBXML "Ret" blocks
          // Matches <Item...Ret> content </Item...Ret>
          const itemBlocks =
            rawXml.match(/<Item[a-zA-Z]+Ret>[\s\S]*?<\/Item[a-zA-Z]+Ret>/g) ||
            [];

          qbData = itemBlocks
            .map((block: string) => {
              const listId = block.match(/<ListID>([^<]+)<\/ListID>/)?.[1];
              const price = block.match(
                /<SalesPrice>([^<]+)<\/SalesPrice>/
              )?.[1];
              const stock = block.match(
                /<QuantityOnHand>([^<]+)<\/QuantityOnHand>/
              )?.[1];
              const name = block.match(/<Name>([^<]+)<\/Name>/)?.[1];

              return {
                ListID: listId,
                SalesPrice: price,
                QuantityOnHand: stock,
                Name: name,
              };
            })
            .filter((i: any) => i.ListID); // Ensure valid ID

          logger.info(`🎉 Parsed ${qbData.length} items from XML.`);
        } else {
          let resultObj = statusJson.operation.result;
          // If result is wrapped in an array, unwrap it securely
          if (Array.isArray(resultObj) && resultObj.length > 0) {
            resultObj = resultObj[0];
          }

          // Unwrap QBXML object if present
          if (resultObj?.QBXML?.QBXMLMsgsRs) {
            resultObj = resultObj.QBXML.QBXMLMsgsRs;
          }

          if (resultObj?.ItemQueryRs) {
            const queryRs = resultObj.ItemQueryRs;
            const inventoryItems = Array.isArray(queryRs.ItemInventoryRet)
              ? queryRs.ItemInventoryRet
              : queryRs.ItemInventoryRet
                ? [queryRs.ItemInventoryRet]
                : [];
            const nonInventoryItems = Array.isArray(queryRs.ItemNonInventoryRet)
              ? queryRs.ItemNonInventoryRet
              : queryRs.ItemNonInventoryRet
                ? [queryRs.ItemNonInventoryRet]
                : [];
            const serviceItems = Array.isArray(queryRs.ItemServiceRet)
              ? queryRs.ItemServiceRet
              : queryRs.ItemServiceRet
                ? [queryRs.ItemServiceRet]
                : [];
            qbData = [...inventoryItems, ...nonInventoryItems, ...serviceItems];
          } else if (resultObj?.ItemSitesQueryRs) {
            const queryRs = resultObj.ItemSitesQueryRs;
            const siteRet = Array.isArray(queryRs.ItemSitesRet)
              ? queryRs.ItemSitesRet
              : queryRs.ItemSitesRet
                ? [queryRs.ItemSitesRet]
                : [];
            qbData = siteRet
              .map((s: any) => ({
                ListID: s.ItemInventoryRef?.ListID,
                QuantityOnHand: s.QuantityOnHand,
                Name: s.ItemInventoryRef?.FullName,
              }))
              .filter((i: any) => i.ListID);
          } else {
            logger.warn(
              `Unrecognized result structure! Root keys: ${Object.keys(resultObj || {})}`
            );
            qbData = Array.isArray(statusJson.operation.data)
              ? statusJson.operation.data
              : [];
          }
        }

        logger.info(`🎉 Sync Completed! Total items: ${qbData?.length || 0}`);
        break;
      } else if (statusJson.operation.status === "failed") {
        logger.error(`❌ Operation Failed: ${statusJson.operation.message}`);
        return;
      }
    }
  }

  if (!qbData || qbData.length === 0) {
    logger.warn("⚠️ Timed out or received empty data.");
    return; // Or allow continuing if in testing with mocked data
  }

  // 5. Processing Updates
  logger.info("\n🔄 Processing Updates...");
  let updatedStock = 0;
  let missingInQb = 0;

  // Map QB Data for fast lookup
  // qbData expected format array of { ListID, SalesPrice, QuantityOnHand, ... }
  const qbMap = new Map(qbData.map((chk: any) => [chk.ListID, chk]));

  for (const variant of qbVariants) {
    const qbId = (variant.metadata as any)?.quickbooks_id;
    const qbItem = qbMap.get(qbId);

    const targetSku = process.env.SYNC_SKU;
    if (targetSku && variant.sku !== targetSku) {
      continue;
    }

    if (!qbItem) {
      // Only log warning we are targeting all or this specific one
      if (!targetSku || targetSku === variant.sku) {
        missingInQb++;
        logger.warn(
          `   ⚠️ Variant ${variant.sku} (QB: ${qbId}) not found in QB Response.`
        );
      }
      continue;
    }

    // Set silent parsing by default, only log meaningful discrepancies
    const newStock = parseInt(qbItem.QuantityOnHand);
    const variantTitle = `${variant.sku}`; // Short log

    // --- Inventory Update ---
    let inventoryItemId = variant.inventory_items?.[0]?.inventory_item_id;

    if (inventoryItemId) {
      if (!isNaN(newStock)) {
        if (isDryRun) {
          // Only log DRY run differences, but we'd need to fetch the level to know for sure.
          // Let's just log it if we really need to, but skip to keep logs clean
        } else {
          try {
            const levels = await inventoryService.listInventoryLevels({
              inventory_item_id: inventoryItemId,
              location_id: locationId,
            });

            if (levels.length > 0) {
              const currentStock = levels[0].stocked_quantity;
              if (currentStock === newStock) {
                // No change, skip database mutation AND log
                continue;
              }

              logger.info(
                `   🔄 [${variantTitle}] Updating Stock: ${currentStock} -> ${newStock}`
              );
              await inventoryService.updateInventoryLevels({
                id: levels[0].id,
                inventory_item_id: inventoryItemId,
                location_id: locationId,
                stocked_quantity: newStock,
              });
            } else {
              logger.info(
                `   ✨ [${variantTitle}] Creating new level with Stock: ${newStock}`
              );
              await inventoryService.createInventoryLevels({
                inventory_item_id: inventoryItemId,
                location_id: locationId,
                stocked_quantity: newStock,
                incoming_quantity: 0,
              });
            }
            updatedStock++;
          } catch (err: any) {
            logger.error(
              `   ❌ Inventory Update Failed for ${variantTitle}: ${err.message}`
            );
          }
        }
      }
    } else {
      logger.warn(
        `   ❌ ${variantTitle}: No Inventory Item linked. Run 'enable-inventory-management' first.`
      );
    }
  }

  logger.info(`\n${"=".repeat(50)}`);
  logger.info("✅ SYNC SUMMARY");
  logger.info(`${"=".repeat(50)}`);
  logger.info(`Total Linked Variants: ${qbVariants.length}`);
  logger.info(`Found in QB:           ${qbVariants.length - missingInQb}`);
  logger.info(`Missing in QB:         ${missingInQb}`);
  logger.info(`Updated Inventory:     ${updatedStock}`);
  logger.info(`${"=".repeat(50)}\n`);
}

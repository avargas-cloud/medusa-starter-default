import { IInventoryService, IStockLocationService } from "@medusajs/types";
import { pollBridgeStatus } from "./bridge-fetch";
import { ContainerRegistrationKeys, Modules } from "@medusajs/utils";

import { syncInventoryWorkflow } from "../../workflows/sync-inventory";

import { isQbIntegrationEnabled } from "./qb-integration-guard";

// Config — URLs and keys from env vars
const BRIDGE_URL = process.env.QB_BRIDGE_URL || "https://qb.eptbridge.com";
const API_KEY = process.env.QB_API_KEY || "mQb-7k9Pzx4RwN2vL8jT3bY6hF5nC1aD";
const POLL_INTERVAL_MS = 30000; // 30 seconds
const MAX_POLL_ATTEMPTS = 20; // 10 minutes max
const QB_PRINCIPAL_WAREHOUSE_ID = "80000001-1331053531";

// Anomaly thresholds
const ANOMALY_DROP_PCT = 0.8; // Flag if stock drops more than 80%
const ANOMALY_ZERO_FROM = 10; // Flag if stock goes to 0 from ≥ this value

/**
 * Retries a fetch up to maxRetries times on 502/503/504 errors.
 * Handles transient Cloudflare Tunnel disconnects without failing the sync.
 */
async function fetchWithRetry(
  url: string,
  options: RequestInit,
  maxRetries = 3,
  retryDelayMs = 8000
): Promise<Response> {
  let lastRes: Response | undefined;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, options);
      if (res.ok || ![502, 503, 504].includes(res.status)) return res;
      lastRes = res;
      if (attempt < maxRetries) {
        console.warn(
          `[QB] Bridge returned ${res.status} (attempt ${attempt}/${maxRetries}) — retrying in ${retryDelayMs / 1000}s...`
        );
        await new Promise((r) => setTimeout(r, retryDelayMs));
      }
    } catch (err: any) {
      console.warn(
        `[QB] Bridge fetch error (attempt ${attempt}/${maxRetries}): ${err.message}`
      );
      if (attempt === maxRetries) throw err;
      await new Promise((r) => setTimeout(r, retryDelayMs));
    }
  }
  return lastRes!; // return last response for caller to handle
}

export interface SyncInventoryPreviewItem {
  sku: string;
  name: string;
  currentStock: number; // current Medusa value
  newStock: number; // QB value
  delta: number; // newStock - currentStock
  isAnomaly: boolean;
  anomalyReason?: string;
  /** true when QB reported negative stock — clamped to 0 (data correction, not real change) */
  wasNegativeInQb?: boolean;
}

export interface SyncInventoryResult {
  success: boolean;
  dryRun?: boolean;
  stats: {
    totalLinkedVariants: number;
    foundInQb: number;
    missingInQb: number;
    updatedStock: number;
    skippedNoInventoryItem: number;
    wouldUpdate?: number; // dry run: how many would change
    skippedNoChange?: number;
  };
  discrepancyReport?: {
    onlyInQb: string[]; // QB items with no matching quickbooks_id in Medusa
    onlyInMedusa: string[]; // Medusa variants not found in QB response
  };
  preview?: SyncInventoryPreviewItem[];
  anomalies?: SyncInventoryPreviewItem[];
  error?: string;
}

/**
 * Core logic for syncing inventory levels from QuickBooks.
 * Can be called from CLI, API route, or scheduled job.
 *
 * @param container  Medusa IoC container
 * @param options    { dryRun?: boolean } — when true, fetches QB data and reports
 *                   what would change WITHOUT writing to Medusa.
 */
export async function syncInventoryCore(
  container: any,
  options: { dryRun?: boolean; onLog?: (line: string) => void } = {}
): Promise<SyncInventoryResult> {
  const dryRun = options.dryRun ?? false;
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  // log() — goes to Medusa logger AND streams to the modal via onLog
  const log = (line: string) => {
    logger.info(line);
    options.onLog?.(line);
  };
  const warn = (line: string) => {
    logger.warn(line);
    options.onLog?.(`⚠️ ${line}`);
  };
  const inventoryService: IInventoryService = container.resolve(
    Modules.INVENTORY
  );
  const stockLocationService: IStockLocationService = container.resolve(
    Modules.STOCK_LOCATION
  );
  const query = container.resolve(ContainerRegistrationKeys.QUERY);

  // Master integration kill switch
  if (!(await isQbIntegrationEnabled())) {
    log("[QB] Integration is DISABLED. Skipping inventory sync.");
    return {
      success: false,
      stats: {
        totalLinkedVariants: 0,
        foundInQb: 0,
        missingInQb: 0,
        updatedStock: 0,
        skippedNoInventoryItem: 0,
      },
      error: "QB integration is disabled",
    };
  }

  const stats = {
    totalLinkedVariants: 0,
    foundInQb: 0,
    missingInQb: 0,
    updatedStock: 0,
    skippedNoInventoryItem: 0,
    wouldUpdate: 0,
    skippedNoChange: 0,
  };

  try {
    log(`📦 Starting QuickBooks INVENTORY Sync (Dry Run: ${dryRun})...`);
    log(
      `⏰ Sync initiated: ${new Date().toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: true, timeZoneName: "short" })}`
    );

    // 1. Get Default Stock Location
    const locations = await stockLocationService.listStockLocations(
      {},
      { take: 1 }
    );
    if (locations.length === 0) {
      const error =
        "No Stock Location found! Create one in Medusa Settings first.";
      logger.error(`❌ ${error}`);
      return { success: false, stats, error };
    }
    const locationId = locations[0]?.id;
    if (!locationId) {
      return { success: false, stats, error: "Stock Location ID is invalid" };
    }
    log(`📍 Using Stock Location: ${locations[0]?.name} (${locationId})`);

    // 2. Fetch Medusa Products with QB ID
    log("🔍 Fetching Medusa Products linked to QuickBooks...");
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
    stats.totalLinkedVariants = qbVariants.length;
    log(`📊 Found ${qbVariants.length} variants linked to QuickBooks.`);

    if (qbVariants.length === 0) {
      return {
        success: false,
        stats,
        error: "No linked products found — run 'assign-quickbooks-ids' first",
      };
    }

    // 3. Initiate Bulk Sync via QB Bridge (with retry for transient 503s)
    log(
      `📡 Requesting Bulk Data from QB Bridge... [Site: Principal Warehouse]`
    );
    const initRes = await fetchWithRetry(
      `${BRIDGE_URL}/api/products/site/${QB_PRINCIPAL_WAREHOUSE_ID}`,
      {
        headers: { "x-api-key": API_KEY, "bypass-tunnel-reminder": "true" },
      }
    );

    if (!initRes.ok) {
      let errorBody = "";
      try {
        errorBody = await initRes.text();
      } catch {
        /* ignore */
      }
      const error = `Bridge Error: ${initRes.status} ${initRes.statusText}${errorBody ? ` — ${errorBody.slice(0, 200)}` : ""}`;
      logger.error(`❌ ${error}`);
      return { success: false, stats, error };
    }

    const initJson: any = await initRes.json();
    const operationId = initJson.operationId;
    log(`✅ Operation Queued! ID: ${operationId}`);

    // 4. Polling Loop — wait for QB Web Connector to process
    let qbData: any[] = [];
    let attempts = 0;

    while (attempts < MAX_POLL_ATTEMPTS) {
      attempts++;
      log(
        `⏳ Polling (${attempts}/${MAX_POLL_ATTEMPTS}) — waiting for QB Web Connector...`
      );

      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

      const polled = await pollBridgeStatus(operationId);
      if (polled.status === "expired") {
        const error = `QB sync op ${operationId} expired (bridge returned 404)`;
        warn(`   ${error}`);
        return { success: false, stats, error };
      }
      const statusJson: any = polled.data;

      if (statusJson.success && statusJson.operation) {
        if (statusJson.operation.status === "completed") {
          // Bridge returns parsed QB XML as JSON (same structure as price sync)
          // Path: operation.result.QBXML.QBXMLMsgsRs.ItemSitesQueryRs.ItemSitesRet[]
          const queryRs =
            statusJson.operation?.result?.QBXML?.QBXMLMsgsRs?.ItemSitesQueryRs;
          if (queryRs) {
            const raw = queryRs.ItemSitesRet || [];
            qbData = Array.isArray(raw) ? raw : [raw];
            // ItemSitesRet fields: ItemInventoryRef.ListID, ItemInventoryRef.FullName, QuantityOnHand
            log(
              `✅ Data received: ${qbData.length} site inventory records from QuickBooks`
            );
          } else {
            warn(
              `⚠️ Unexpected Bridge response shape — no ItemSitesQueryRs found`
            );
            log(
              `   Raw operation keys: ${Object.keys(statusJson.operation?.result?.QBXML?.QBXMLMsgsRs || {}).join(", ")}`
            );
          }
          break;
        }

        if (statusJson.operation.status === "failed") {
          const error = `QB operation failed: ${statusJson.operation.error || "Unknown"}`;
          logger.error(`❌ ${error}`);
          return { success: false, stats, error };
        }

        log(`   Status: ${statusJson.operation.status} — waiting...`);
      }
    }

    if (qbData.length === 0) {
      const error = "No data received after polling timeout";
      logger.error(`❌ ${error}`);
      return { success: false, stats, error };
    }

    // 5. Build lookup maps
    const medusaQbIds = new Set(
      qbVariants.map((v: any) => v.metadata?.quickbooks_id)
    );
    const allQbIds = new Set(
      qbData.map((item: any) => item.ItemInventoryRef?.ListID)
    );
    const onlyInQb = qbData
      .filter((item: any) => !medusaQbIds.has(item.ItemInventoryRef?.ListID))
      .map(
        (item: any) =>
          item.ItemInventoryRef?.FullName || item.ItemInventoryRef?.ListID
      );
    const onlyInMedusa = qbVariants
      .filter((v: any) => !allQbIds.has(v.metadata?.quickbooks_id))
      .map((v: any) => v.sku || v.id);

    const qbMap = new Map(
      qbData.map((item: any) => [item.ItemInventoryRef?.ListID, item])
    );

    // 6. Pre-fetch ALL current inventory levels to avoid 2400 sequential DB queries
    log("🔍 Fetching existing Medusa inventory levels...");
    const allLevels = await inventoryService.listInventoryLevels(
      { location_id: locationId },
      { take: 10000 }
    );
    const levelsMap = new Map();
    for (const level of allLevels) {
      levelsMap.set(level.inventory_item_id, level);
    }

    // 7. Process each variant entirely in-memory first
    const preview: SyncInventoryPreviewItem[] = [];
    const anomalies: SyncInventoryPreviewItem[] = [];
    const updatesToApply: any[] = [];
    const createsToApply: any[] = [];

    for (const variant of qbVariants) {
      const qbId = (variant.metadata as any)?.quickbooks_id;
      let qbItem = qbMap.get(qbId);

      if (!qbItem) {
        stats.missingInQb++;
        // QuickBooks ItemSitesQuery omits products not physically tracked in the site
        // We assume stock 0
        qbItem = {
          QuantityOnHand: "0",
          ItemInventoryRef: { ListID: qbId, FullName: variant.sku },
        };
      }

      stats.foundInQb++;

      const rawStock = parseInt(qbItem.QuantityOnHand);
      const inventoryItemId = variant.inventory_items?.[0]?.inventory_item_id;

      if (!inventoryItemId) {
        stats.skippedNoInventoryItem++;
        warn(`   ❌ ${variant.sku}: No Inventory Item linked`);
        continue;
      }

      if (isNaN(rawStock)) {
        warn(
          `   ⚠️ ${variant.sku}: Invalid QB stock value "${qbItem.QuantityOnHand}"`
        );
        continue;
      }

      // Clamp negatives to 0
      const newStock = rawStock < 0 ? 0 : rawStock;

      // Get current stock from pre-fetched RAM Map
      const level = levelsMap.get(inventoryItemId);
      const currentStock = level?.stocked_quantity ?? 0;
      const delta = newStock - currentStock;

      if (rawStock < 0 && currentStock > 0) {
        warn(
          `   ⚠️ ${variant.sku}: QB reported negative stock (${rawStock}) → clamped to 0 (Medusa had ${currentStock})`
        );
      }

      // Skip if no change
      if (delta === 0) {
        stats.skippedNoChange!++;
        continue;
      }

      // Anomaly detection
      let isAnomaly = false;
      let anomalyReason: string | undefined;

      if (newStock === 0 && currentStock >= ANOMALY_ZERO_FROM) {
        isAnomaly = true;
        anomalyReason = `Stock goes to 0 from ${currentStock} units`;
      } else if (
        currentStock > 0 &&
        (currentStock - newStock) / currentStock >= ANOMALY_DROP_PCT
      ) {
        isAnomaly = true;
        anomalyReason = `Stock drops ${Math.round(((currentStock - newStock) / currentStock) * 100)}% (${currentStock} → ${newStock})`;
      }

      const previewItem: SyncInventoryPreviewItem = {
        sku: variant.sku || variant.id,
        name: qbItem.ItemInventoryRef?.FullName || variant.sku,
        currentStock,
        newStock,
        delta,
        isAnomaly,
        anomalyReason,
        wasNegativeInQb: rawStock < 0,
      };

      preview.push(previewItem);
      if (isAnomaly) anomalies.push(previewItem);

      if (dryRun) {
        const flag = isAnomaly ? "⚠️  ANOMALY" : delta > 0 ? "▲" : "▼";
        log(
          `   [DRY] ${variant.sku}: ${currentStock} → ${newStock} (${delta > 0 ? "+" : ""}${delta}) ${flag}${anomalyReason ? ` — ${anomalyReason}` : ""}`
        );
        stats.wouldUpdate!++;
      } else {
        // Queue for bulk application
        if (level) {
          updatesToApply.push({
            id: level.id,
            inventory_item_id: inventoryItemId,
            location_id: locationId,
            stocked_quantity: newStock,
          });
        } else {
          createsToApply.push({
            inventory_item_id: inventoryItemId,
            location_id: locationId,
            stocked_quantity: newStock,
            incoming_quantity: 0,
          });
        }
      }
    }

    // 8. Apply queued changes in BULK (PostgreSQL batches)
    if (!dryRun) {
      log(
        `⚡ Applying ${updatesToApply.length} updates and ${createsToApply.length} creations in mass batches...`
      );
      const BULK_SIZE = 500;

      if (updatesToApply.length > 0) {
        for (let i = 0; i < updatesToApply.length; i += BULK_SIZE) {
          const chunk = updatesToApply.slice(i, i + BULK_SIZE);
          try {
            await inventoryService.updateInventoryLevels(chunk);
            stats.updatedStock += chunk.length;
            log(
              `   ✅ Batch progress: ${stats.updatedStock}/${updatesToApply.length} existing items adjusted...`
            );
          } catch (err: any) {
            logger.error(`   ❌ Update chunk failed: ${err.message}`);
          }
        }
      }

      if (createsToApply.length > 0) {
        for (let i = 0; i < createsToApply.length; i += BULK_SIZE) {
          const chunk = createsToApply.slice(i, i + BULK_SIZE);
          try {
            await inventoryService.createInventoryLevels(chunk);
            log(
              `   ✅ Batch progress: +${chunk.length} new records created...`
            );
          } catch (err: any) {
            logger.error(`   ❌ Create chunk failed: ${err.message}`);
          }
        }
      }
    }

    // 7. Summary
    log(`\n${"=".repeat(50)}`);
    log(
      dryRun ? "📊 DRY RUN INVENTORY SYNC PREVIEW" : "✅ INVENTORY SYNC SUMMARY"
    );
    log(`${"=".repeat(50)}`);
    log(`Total Linked Variants:  ${stats.totalLinkedVariants}`);
    log(`Found in QB:            ${stats.foundInQb}`);
    log(`Missing in QB:          ${stats.missingInQb}`);
    if (dryRun) {
      log(`Would Update:           ${stats.wouldUpdate}`);
      log(`No Change (skipped):    ${stats.skippedNoChange}`);
      log(`Anomalies Detected:     ${anomalies.length}`);
    } else {
      log(`Updated:                ${stats.updatedStock}`);
      log(`Skipped (No Change):    ${stats.skippedNoChange}`);
    }
    log(`Skipped (No Inv Item):  ${stats.skippedNoInventoryItem}`);

    // Detailed list of every SKU whose stock changed
    if (preview.length > 0) {
      const heading = dryRun
        ? `\n📝 ADJUSTMENTS THAT WOULD APPLY (${preview.length}):`
        : `\n📝 ADJUSTMENTS APPLIED (${preview.length}):`;
      log(heading);
      // Sort by absolute delta desc so the biggest swings show first
      const sorted = [...preview].sort(
        (a, b) => Math.abs(b.delta) - Math.abs(a.delta),
      );
      const MAX_ROWS = 500;
      sorted.slice(0, MAX_ROWS).forEach((p) => {
        const arrow = p.delta > 0 ? "▲" : "▼";
        const sign = p.delta > 0 ? "+" : "";
        const flag = p.isAnomaly ? "  ⚠️" : "";
        log(
          `   ${arrow} ${p.sku}: ${p.currentStock} → ${p.newStock} (${sign}${p.delta})${flag}`,
        );
      });
      if (sorted.length > MAX_ROWS) {
        log(`   ... and ${sorted.length - MAX_ROWS} more`);
      }
    }

    if (anomalies.length > 0) {
      log(
        `\n⚠️  ANOMALIES (${anomalies.length}) — review before syncing live:`
      );
      anomalies.forEach((a) => log(`   • ${a.sku}: ${a.anomalyReason}`));
    }

    if (onlyInQb.length > 0) {
      log(
        `\n📊 ${onlyInQb.length} QB items have no Medusa match (not on website):`
      );
      onlyInQb.slice(0, 10).forEach((name) => log(`   • ${name}`));
      if (onlyInQb.length > 10) log(`   ... and ${onlyInQb.length - 10} more`);
    }
    log(`${"=".repeat(50)}\n`);

    // ─── Auto re-index Meilisearch after a successful live sync ──────────
    if (!dryRun && stats.updatedStock > 0) {
      log("🔄 Re-indexing Meilisearch inventory index...");
      try {
        await syncInventoryWorkflow(container).run({ input: {} });
        log(`✅ Meilisearch re-indexed successfully`);
      } catch (meiliErr: any) {
        // Non-blocking — inventory update succeeded even if Meilisearch fails
        warn(
          `⚠️  Meilisearch re-index failed (inventory sync still succeeded): ${meiliErr.message}`
        );
      }
    }

    return {
      success: true,
      dryRun,
      stats,
      discrepancyReport: { onlyInQb, onlyInMedusa },
      preview,
      anomalies,
    };
  } catch (error: any) {
    logger.error(`❌ Sync failed: ${error.message}`);
    return { success: false, stats, error: error.message };
  }
}

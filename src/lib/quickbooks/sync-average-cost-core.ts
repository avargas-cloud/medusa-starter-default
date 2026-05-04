import { ContainerRegistrationKeys } from "@medusajs/utils";
import { Client } from "pg";

import { syncInventoryWorkflow } from "../../workflows/sync-inventory";
import {
  toSnapshot,
  type QbItemRaw,
} from "./bulk-item-types";
import { isQbIntegrationEnabled } from "./qb-integration-guard";

const BRIDGE_URL = process.env.QB_BRIDGE_URL || "https://qb.eptbridge.com";
const API_KEY =
  process.env.QB_API_KEY || "mQb-7k9Pzx4RwN2vL8jT3bY6hF5nC1aD";
const POLL_INTERVAL_MS = 30_000;
const MAX_POLL_ATTEMPTS = 20;
const METADATA_BATCH = 500;

type QbItemRetBlock = Record<string, unknown>;

type BridgeOperation = {
  status?: string;
  error?: string;
  message?: string;
  result?: {
    QBXML?: { QBXMLMsgsRs?: { ItemQueryRs?: Record<string, unknown> } };
    ItemQueryRs?: Record<string, unknown>;
  };
};

type VariantRow = {
  id: string;
  sku: string | null;
  metadata: Record<string, unknown> | null;
  product: { id: string } | null;
};

type VariantUpdate = {
  id: string;
  productId: string;
  sku: string;
  metadata: Record<string, unknown>;
};

export interface SyncAverageCostResult {
  success: boolean;
  dryRun?: boolean;
  stats: {
    totalLinkedVariants: number;
    foundInQb: number;
    missingInQb: number;
    updatedAverageCost: number;
    skippedNoAverageCost: number;
    skippedNoChange: number;
    meiliReindexed: number;
  };
  error?: string;
}

function asArray<T>(value: T | T[] | null | undefined): T[] {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function textField(item: QbItemRetBlock, key: string): string | undefined {
  return typeof item[key] === "string" ? item[key] : undefined;
}

function numberField(
  item: QbItemRetBlock,
  key: string
): string | number | undefined {
  const value = item[key];
  return typeof value === "string" || typeof value === "number"
    ? value
    : undefined;
}

function toInventoryRaw(item: QbItemRetBlock): QbItemRaw | null {
  const listId = textField(item, "ListID");
  if (!listId) return null;
  return {
    ListID: listId,
    EditSequence: textField(item, "EditSequence"),
    Name: textField(item, "Name"),
    FullName: textField(item, "FullName"),
    IsActive:
      textField(item, "IsActive") ??
      (typeof item.IsActive === "boolean" ? item.IsActive : undefined),
    PurchaseCost: numberField(item, "PurchaseCost"),
    AverageCost: numberField(item, "AverageCost"),
    itemType: "Inventory",
  };
}

function parseInventoryItems(queryRs: Record<string, unknown>): QbItemRaw[] {
  const blocks = asArray(
    queryRs.ItemInventoryRet as QbItemRetBlock | QbItemRetBlock[] | undefined
  );
  return blocks
    .map(toInventoryRaw)
    .filter((item): item is QbItemRaw => item !== null);
}

async function fetchBridgeJson(url: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: {
      "x-api-key": API_KEY,
      "bypass-tunnel-reminder": "true",
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Bridge error ${res.status} ${res.statusText}${body ? ` — ${body.slice(0, 300)}` : ""}`
    );
  }
  return res.json();
}

async function fetchQbAverageCostItems(log: (line: string) => void) {
  log(`[QB] Requesting active inventory items with AverageCost from ${BRIDGE_URL}`);
  const initJson = (await fetchBridgeJson(
    `${BRIDGE_URL}/api/products/active-with-description`
  )) as { operationId?: string };
  const operationId = initJson.operationId;
  if (!operationId) throw new Error("Bridge did not return operationId");

  log(`[QB] Operation queued: ${operationId}`);

  for (let attempt = 1; attempt <= MAX_POLL_ATTEMPTS; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    log(`⏳ Polling Status (${attempt}/${MAX_POLL_ATTEMPTS})...`);

    const body = (await fetchBridgeJson(
      `${BRIDGE_URL}/api/sync/status/${operationId}`
    )) as { operation?: BridgeOperation };
    const operation = body.operation;
    if (!operation) continue;

    if (operation.status === "failed") {
      throw new Error(
        `Bridge operation failed: ${operation.error ?? operation.message ?? "unknown"}`
      );
    }

    if (operation.status === "completed") {
      const queryRs =
        operation.result?.QBXML?.QBXMLMsgsRs?.ItemQueryRs ??
        operation.result?.ItemQueryRs;
      if (!queryRs) {
        throw new Error("Bridge completed but returned no ItemQueryRs");
      }
      const items = parseInventoryItems(queryRs);
      log(`✅ Data Received! ${items.length} inventory items from QuickBooks.`);
      return { operationId, items };
    }
  }

  throw new Error(
    `No data received after polling timeout (${MAX_POLL_ATTEMPTS} attempts)`
  );
}

function readNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

async function applyAverageCostUpdates(
  updates: VariantUpdate[]
): Promise<number> {
  if (updates.length === 0) return 0;

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    let updated = 0;
    for (let i = 0; i < updates.length; i += METADATA_BATCH) {
      const chunk = updates.slice(i, i + METADATA_BATCH);
      const ids = chunk.map((row) => row.id);
      const metas = chunk.map((row) => JSON.stringify(row.metadata));
      const result = await client.query(
        `
          UPDATE product_variant AS pv
             SET metadata = u.metadata::jsonb,
                 updated_at = NOW()
            FROM UNNEST($1::text[], $2::text[]) AS u(id, metadata)
           WHERE pv.id = u.id
        `,
        [ids, metas]
      );
      updated += result.rowCount ?? 0;
    }
    return updated;
  } finally {
    await client.end();
  }
}

export async function syncAverageCostCore(
  container: any,
  options: { dryRun?: boolean; onLog?: (line: string) => void } = {}
): Promise<SyncAverageCostResult> {
  const dryRun = options.dryRun || process.env.QB_DRY_RUN === "true";
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const query = container.resolve(ContainerRegistrationKeys.QUERY);

  const log = (line: string) => {
    logger.info(line);
    options.onLog?.(line);
  };
  const warn = (line: string) => {
    logger.warn(line);
    options.onLog?.(`⚠️ ${line}`);
  };

  const stats = {
    totalLinkedVariants: 0,
    foundInQb: 0,
    missingInQb: 0,
    updatedAverageCost: 0,
    skippedNoAverageCost: 0,
    skippedNoChange: 0,
    meiliReindexed: 0,
  };

  if (!(await isQbIntegrationEnabled())) {
    log("[QB] Integration is DISABLED. Skipping average cost sync.");
    return {
      success: false,
      dryRun,
      stats,
      error: "QB integration is disabled",
    };
  }

  try {
    log(
      `📊 Starting QuickBooks AVERAGE COST Sync${dryRun ? " [DRY RUN — no changes will be written]" : ""}`
    );
    log(
      `⏰ Sync initiated: ${new Date().toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: true,
        timeZoneName: "short",
      })}`
    );

    log("🔍 Fetching Medusa variants linked to QuickBooks...");
    const { data: variants } = await query.graph({
      entity: "variant",
      fields: ["id", "sku", "metadata", "product.id"],
    });

    const linkedVariants = (variants as VariantRow[]).filter(
      (variant) =>
        typeof variant.metadata?.quickbooks_id === "string" &&
        variant.metadata.quickbooks_id.length > 0
    );
    stats.totalLinkedVariants = linkedVariants.length;
    log(`📊 Found ${linkedVariants.length} variants linked to QuickBooks.`);

    if (linkedVariants.length === 0) {
      return { success: false, dryRun, stats, error: "No linked products found" };
    }

    const { items } = await fetchQbAverageCostItems(log);
    const qbByListId = new Map(
      items.map((item) => [item.ListID, toSnapshot(item)])
    );

    const updates: VariantUpdate[] = [];
    const touchedProductIds = new Set<string>();

    for (const variant of linkedVariants) {
      const qbId = variant.metadata?.quickbooks_id as string;
      const qb = qbByListId.get(qbId);

      if (!qb) {
        stats.missingInQb++;
        warn(`   ${variant.sku ?? variant.id}: not found in QB response`);
        continue;
      }
      stats.foundInQb++;

      if (qb.avgCost === undefined || qb.avgCost === null) {
        stats.skippedNoAverageCost++;
        continue;
      }

      const currentAverageCost = readNumber(variant.metadata?.qb_avg_cost);
      if (
        currentAverageCost !== null &&
        Math.abs(currentAverageCost - qb.avgCost) < 0.0001
      ) {
        stats.skippedNoChange++;
        continue;
      }

      const sku = variant.sku ?? qb.sku ?? variant.id;
      if (dryRun) {
        log(
          `   [DRY RUN] Would update ${sku}: ${currentAverageCost ?? "null"} → ${qb.avgCost}`
        );
      }

      updates.push({
        id: variant.id,
        productId: variant.product?.id ?? "",
        sku,
        metadata: {
          ...(variant.metadata ?? {}),
          qb_avg_cost: qb.avgCost,
        },
      });
      if (variant.product?.id) touchedProductIds.add(variant.product.id);
    }

    stats.updatedAverageCost = updates.length;

    if (!dryRun) {
      log(`⚡ Applying ${updates.length} average cost metadata updates...`);
      const rowCount = await applyAverageCostUpdates(updates);
      log(`✅ product_variant.metadata updated: ${rowCount}`);

      if (updates.length > 0) {
        log("🔍 Re-indexing Meilisearch inventory with updated costs...");
        try {
          const meiliResult = await syncInventoryWorkflow(container).run({
            input: {},
          });
          stats.meiliReindexed = meiliResult.result.synced;
          log(`✅ Meilisearch re-indexed ${stats.meiliReindexed} inventory items`);
        } catch (meiliErr) {
          warn(
            `Meilisearch re-index failed (non-blocking): ${(meiliErr as Error).message}`
          );
        }
      }
    }

    log(`\n${"=".repeat(50)}`);
    log(`✅ AVERAGE COST SYNC SUMMARY${dryRun ? " [DRY RUN]" : ""}`);
    log(`${"=".repeat(50)}`);
    log(`Total Linked Variants:     ${stats.totalLinkedVariants}`);
    log(`Found in QB:               ${stats.foundInQb}`);
    log(`Missing in QB:             ${stats.missingInQb}`);
    log(
      `Updated Average Cost:      ${stats.updatedAverageCost}${dryRun ? " (would update)" : ""}`
    );
    log(`Skipped (No Avg Cost):     ${stats.skippedNoAverageCost}`);
    log(`Skipped (Unchanged):       ${stats.skippedNoChange}`);
    log(`Meili Reindexed:           ${stats.meiliReindexed}`);
    log(`${"=".repeat(50)}\n`);

    return { success: true, dryRun, stats };
  } catch (error) {
    const message = (error as Error).message;
    logger.error(`❌ Average cost sync failed: ${message}`);
    return { success: false, dryRun, stats, error: message };
  }
}

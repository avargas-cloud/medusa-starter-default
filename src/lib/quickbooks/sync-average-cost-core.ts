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

export type AvgCostSyncScope = "all" | "non_china";

/**
 * Coarse progress signal for the durable qb_avg_cost_sync_run row that the POS
 * "Cost Sync" card polls. `fetching` covers the slow QB bridge pull (processed
 * stays 0, card shows "Waiting for QuickBooks…"); `processing` animates the
 * per-chunk matching/writing.
 */
export type AvgCostSyncProgress = {
  phase: "fetching" | "processing";
  total: number;
  processed: number;
  updated: number;
  unchanged: number;
  skipped: number;
};

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

/**
 * Resolve the set of NON-China variant IDs via raw Postgres. A product is China
 * when product.metadata.is_sourced_via_agent is truthy; everything else
 * (including NULL/absent metadata) is non-China.
 */
async function fetchNonChinaVariantIds(
  container: any
): Promise<Set<string>> {
  const pg = container.resolve("__pg_connection__") as {
    raw: (
      sql: string,
      bindings?: unknown[]
    ) => Promise<{ rows: Array<{ id: string }> }>;
  };
  const { rows } = await pg.raw(
    `SELECT pv.id
       FROM product_variant pv
       JOIN product p ON p.id = pv.product_id
      WHERE pv.deleted_at IS NULL
        AND p.deleted_at IS NULL
        AND (p.metadata->>'is_sourced_via_agent') IS DISTINCT FROM 'true'`
  );
  return new Set(rows.map((r) => String(r.id)));
}

export async function syncAverageCostCore(
  container: any,
  options: {
    dryRun?: boolean;
    onLog?: (line: string) => void;
    scope?: AvgCostSyncScope;
    onProgress?: (p: AvgCostSyncProgress) => void | Promise<void>;
  } = {}
): Promise<SyncAverageCostResult> {
  const dryRun = options.dryRun || process.env.QB_DRY_RUN === "true";
  const scope: AvgCostSyncScope = options.scope ?? "all";
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

    let linkedVariants = (variants as VariantRow[]).filter(
      (variant) =>
        typeof variant.metadata?.quickbooks_id === "string" &&
        variant.metadata.quickbooks_id.length > 0
    );

    // Scope filter. For 'non_china' we resolve the eligible variant IDs via raw
    // Postgres (Medusa v2 query.graph does NOT reliably hydrate product.metadata
    // JSONB — same footgun that forces raw SQL elsewhere in this codebase), then
    // intersect. `->>` normalizes both the JSON string "true" and boolean true;
    // IS DISTINCT FROM keeps NULL/absent metadata as non-China.
    if (scope === "non_china") {
      const nonChinaIds = await fetchNonChinaVariantIds(container);
      linkedVariants = linkedVariants.filter((v) => nonChinaIds.has(v.id));
      log(
        `🌎 Scope=non_china → ${linkedVariants.length} non-China QB-linked variants.`
      );
    }

    stats.totalLinkedVariants = linkedVariants.length;
    log(`📊 Found ${linkedVariants.length} variants linked to QuickBooks.`);

    if (linkedVariants.length === 0) {
      return { success: false, dryRun, stats, error: "No linked products found" };
    }

    // Enter the slow bridge-pull phase. total is already known so the POS card
    // can render "0 / N · Waiting for QuickBooks…".
    await options.onProgress?.({
      phase: "fetching",
      total: linkedVariants.length,
      processed: 0,
      updated: 0,
      unchanged: 0,
      skipped: 0,
    });

    const { items } = await fetchQbAverageCostItems(log);
    const qbByListId = new Map(
      items.map((item) => [item.ListID, toSnapshot(item)])
    );

    const updates: VariantUpdate[] = [];
    const touchedProductIds = new Set<string>();

    let processed = 0;
    const PROGRESS_EVERY = 200;
    const emitProgress = async () => {
      await options.onProgress?.({
        phase: "processing",
        total: linkedVariants.length,
        processed,
        updated: updates.length - stats.skippedNoChange,
        unchanged: stats.skippedNoChange,
        skipped: stats.skippedNoAverageCost + stats.missingInQb,
      });
    };

    for (const variant of linkedVariants) {
      processed++;
      if (processed % PROGRESS_EVERY === 0) await emitProgress();

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
      const isUnchanged =
        currentAverageCost !== null &&
        Math.abs(currentAverageCost - qb.avgCost) < 0.0001;

      const sku = variant.sku ?? qb.sku ?? variant.id;
      if (dryRun) {
        log(
          isUnchanged
            ? `   [DRY RUN] Would refresh sync timestamp for ${sku} (cost unchanged at ${qb.avgCost})`
            : `   [DRY RUN] Would update ${sku}: ${currentAverageCost ?? "null"} → ${qb.avgCost}`
        );
      }

      // Always bump qb_avg_cost_synced_at on every successful sync — gives
      // downstream snapshots a "we confirmed this cost as of T" signal even
      // when the value itself didn't change. New invoices/credit-memos copy
      // both fields into their average_unit_cost{,_synced_at} columns.
      updates.push({
        id: variant.id,
        productId: variant.product?.id ?? "",
        sku,
        metadata: {
          ...(variant.metadata ?? {}),
          qb_avg_cost: qb.avgCost,
          qb_avg_cost_synced_at: new Date().toISOString(),
        },
      });
      if (isUnchanged) stats.skippedNoChange++;
      if (variant.product?.id) touchedProductIds.add(variant.product.id);
    }

    await emitProgress();

    // updatedAverageCost reflects rows whose qb_avg_cost actually changed.
    // updates.length includes timestamp-only refreshes (cost unchanged) too;
    // separate the count so the stats line stays meaningful.
    stats.updatedAverageCost = updates.length - stats.skippedNoChange;

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

import { ContainerRegistrationKeys } from "@medusajs/utils";
import { Client } from "pg";

import { USA_LOC } from "../locations";
import { syncInventoryWorkflow } from "../../workflows/sync-inventory";
import {
  toSnapshot,
  type QbItemRaw,
} from "./bulk-item-types";
import { isQbIntegrationEnabled } from "./qb-integration-guard";
import { requireBridgeUrl } from "./bridge-url";

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
  // Only the cost keys to MERGE into metadata (never a full-blob replace —
  // that would stomp concurrent metadata edits).
  patch: Record<string, unknown>;
  // The average_cost transition this row represents, for the variant_cost_event
  // journal. Both null when this run isn't touching average_cost at all
  // (scope 'all' leaves China's landed cost alone), so no event is written.
  previousAverageCost: number | null;
  newAverageCost: number | null;
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

/**
 * Exported so read-only diagnostics can ask QuickBooks what it currently holds
 * without duplicating the bridge's queue-and-poll dance (see
 * `scripts/checks/fetch-qb-costs-for-missing.ts`). Callers that only want to
 * LOOK must not go on to call `applyAverageCostUpdates`.
 */
export async function fetchQbAverageCostItems(log: (line: string) => void) {
  log(`[QB] Requesting active inventory items with AverageCost from ${requireBridgeUrl()}`);
  const initJson = (await fetchBridgeJson(
    `${requireBridgeUrl()}/api/products/active-with-description`
  )) as { operationId?: string };
  const operationId = initJson.operationId;
  if (!operationId) throw new Error("Bridge did not return operationId");

  log(`[QB] Operation queued: ${operationId}`);

  for (let attempt = 1; attempt <= MAX_POLL_ATTEMPTS; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    log(`⏳ Polling Status (${attempt}/${MAX_POLL_ATTEMPTS})...`);

    const body = (await fetchBridgeJson(
      `${requireBridgeUrl()}/api/sync/status/${operationId}`
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

/**
 * Threshold for "the canonical cost actually moved". Same epsilon the
 * unchanged-check above uses, so a float wobble never mints a journal entry.
 */
const COST_EPSILON = 0.0001;

function movedAverageCost(row: VariantUpdate): boolean {
  if (row.newAverageCost === null) return false;
  if (row.previousAverageCost === null) return true;
  return Math.abs(row.previousAverageCost - row.newAverageCost) >= COST_EPSILON;
}

/**
 * Append one `variant_cost_event` per variant whose canonical `average_cost`
 * actually changed in this chunk.
 *
 * WHY (2026-07-23): this sync is the single largest cost writer in the system
 * — 2,463 of 2,506 costed variants carry `average_cost_source = 'sync'` — and
 * until now it left NO trace. `qb_avg_cost_sync_run` stores only counters
 * (total / updated / skipped), so every run destroyed the outgoing costs
 * permanently. That is why the Supply Chain report has to value historical
 * inventory at today's cost, and why June 2026 was being priced with costs
 * that did not exist until the 2026-07-17 run.
 *
 * Runs in the SAME transaction as the metadata write on purpose, unlike the
 * vendor-bill confirm path which appends non-fatally. The failure mode this
 * table exists to prevent IS "cost changed, no record of it" — making the
 * journal best-effort here would reintroduce exactly that. A chunk that can't
 * journal rolls back its cost writes too and is reported; the run continues
 * with the remaining chunks rather than dying outright.
 *
 * `effective_at` is the moment the sync OBSERVED the cost, which is not
 * necessarily the QuickBooks transaction date that caused it — QB can post a
 * backdated bill, a value adjustment, or a negative-inventory correction. It's
 * flagged in `metadata` so a later reader doesn't mistake a July reconciliation
 * for June operating activity.
 */
async function insertCostEvents(
  client: Client,
  chunk: VariantUpdate[],
  runToken: string
): Promise<number> {
  const moved = chunk.filter(movedAverageCost);
  if (moved.length === 0) return 0;

  const result = await client.query(
    `
      INSERT INTO variant_cost_event
        (id, product_variant_id, stock_location_id, event_type, cost_field,
         effective_at, recorded_at, previous_unit_cost, new_unit_cost,
         quantity_on_hand_at_event, inventory_value_delta_cents,
         source_system, source_type, source_id, status, idempotency_key,
         reason_code, metadata)
      SELECT
        'vce_qs_' || substr(md5($4::text || u.variant_id), 1, 20),
        u.variant_id,
        $5::text,
        'qb_sync',
        'average_cost',
        NOW(), NOW(),
        u.prev_cost,
        u.new_cost,
        q.stocked,
        ROUND(
          COALESCE(q.stocked, 0)
          * (u.new_cost - COALESCE(u.prev_cost, u.new_cost))
          * 100
        )::bigint,
        'quickbooks', 'qb_avg_cost_sync', $4::text, 'active',
        'qb_sync:' || $4::text || ':' || u.variant_id,
        'qb_average_cost_sync',
        jsonb_build_object(
          'effective_at_is', 'sync observation time, not the QuickBooks transaction date'
        )
      FROM UNNEST($1::text[], $2::numeric[], $3::numeric[])
        AS u(variant_id, prev_cost, new_cost)
      LEFT JOIN LATERAL (
        SELECT SUM(il.stocked_quantity)::int AS stocked
          FROM inventory_level il
          JOIN inventory_item ii ON ii.id = il.inventory_item_id
          JOIN product_variant_inventory_item pvii
            ON pvii.inventory_item_id = ii.id
         WHERE pvii.variant_id = u.variant_id
           AND il.location_id = $5::text
      ) q ON TRUE
      ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
    `,
    [
      moved.map((row) => row.id),
      moved.map((row) => row.previousAverageCost),
      moved.map((row) => row.newAverageCost),
      runToken,
      USA_LOC,
    ]
  );
  return result.rowCount ?? 0;
}

async function applyAverageCostUpdates(
  updates: VariantUpdate[],
  runToken: string,
  warn: (line: string) => void
): Promise<{ updated: number; costEvents: number; failedChunks: number }> {
  if (updates.length === 0) return { updated: 0, costEvents: 0, failedChunks: 0 };

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    let updated = 0;
    let costEvents = 0;
    let failedChunks = 0;
    for (let i = 0; i < updates.length; i += METADATA_BATCH) {
      const chunk = updates.slice(i, i + METADATA_BATCH);
      const ids = chunk.map((row) => row.id);
      const metas = chunk.map((row) => JSON.stringify(row.patch));
      try {
        await client.query("BEGIN");
        const result = await client.query(
          `
            UPDATE product_variant AS pv
               SET metadata = COALESCE(pv.metadata, '{}'::jsonb) || u.patch::jsonb,
                   updated_at = NOW()
              FROM UNNEST($1::text[], $2::text[]) AS u(id, patch)
             WHERE pv.id = u.id
          `,
          [ids, metas]
        );
        costEvents += await insertCostEvents(client, chunk, runToken);
        await client.query("COMMIT");
        updated += result.rowCount ?? 0;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        failedChunks++;
        warn(
          `cost chunk ${i / METADATA_BATCH + 1} rolled back (${chunk.length} variants): ` +
            `${error instanceof Error ? error.message : String(error)}. ` +
            `Their costs were NOT changed — no cost change is recorded without its history entry.`
        );
      }
    }
    return { updated, costEvents, failedChunks };
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
  // One token per invocation, used as the variant_cost_event idempotency key
  // and source_id. It scopes the key to THIS run on purpose: the chunk loop
  // can't double-insert, but a genuinely new run is a new observation of QB
  // and must be free to record another transition.
  const runToken = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
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
      const nowIso = new Date().toISOString();
      const patch: Record<string, unknown> = {
        qb_avg_cost: qb.avgCost,
        qb_avg_cost_synced_at: nowIso,
      };
      // Canonical convergence field (Phase 1): only maintain average_cost here
      // for the non-China (USA) sync — USA's average_cost mirrors the
      // QuickBooks average. China's average_cost is owned by vendor-bill
      // confirm (source 'landed'); a scope='all' run must NOT stamp 'sync'
      // over it.
      let previousAverageCost: number | null = null;
      let newAverageCost: number | null = null;
      if (scope === "non_china") {
        patch.average_cost = qb.avgCost;
        patch.average_cost_updated_at = nowIso;
        patch.average_cost_source = "sync";
        // Captured BEFORE the overwrite — this is the only moment the outgoing
        // value still exists anywhere. Note it reads `average_cost`, not
        // `qb_avg_cost`: the "unchanged" check above compares QB's mirror,
        // but the journal has to record the canonical field's own transition
        // (they can differ, e.g. right after a restatement).
        previousAverageCost = readNumber(variant.metadata?.average_cost);
        newAverageCost = qb.avgCost;
      }
      updates.push({
        id: variant.id,
        productId: variant.product?.id ?? "",
        sku,
        patch,
        previousAverageCost,
        newAverageCost,
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
      const applied = await applyAverageCostUpdates(updates, runToken, warn);
      log(`✅ product_variant.metadata updated: ${applied.updated}`);
      log(`🧾 variant_cost_event rows appended: ${applied.costEvents}`);
      if (applied.failedChunks > 0) {
        warn(
          `${applied.failedChunks} chunk(s) rolled back — those variants kept their previous cost. Re-run the sync.`
        );
      }

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

import { MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/utils";

import { INVENTORY_COUNT_MODULE } from "../modules/inventory-count";

/**
 * QB Inventory Adjustment poller.
 *
 * Two-phase loop, runs every minute:
 *
 *   Send phase  — rows with status='waiting' (or 'error' eligible for retry)
 *                 that have no qb_operation_id yet:
 *                 1. resolve qb_list_id for every line via qb_item_pipeline
 *                 2. POST to {bridge}/api/inventory-adjustments
 *                 3. mark status='processing', store qb_operation_id
 *
 *   Poll phase  — rows with status='processing' AND qb_operation_id:
 *                 1. GET {bridge}/api/sync/status/:operationId
 *                 2. on 'completed' → mark synced, store TxnID
 *                 3. on 'failed'    → mark error, schedule exponential retry
 *
 * Idempotency: the bridge dedupes by `dedupeKey: inventory-adjustment:{external_id}`,
 * so re-sending the same row is safe (the bridge returns the original op).
 */

const BRIDGE_URL = process.env.QB_BRIDGE_URL || "https://qb.eptbridge.com";
const API_KEY = process.env.QB_API_KEY || "";
const MAX_ROWS_PER_TICK = 25;
const MAX_RETRIES = 5;

const COMMON_HEADERS: Record<string, string> = {
  "x-api-key": API_KEY,
  "bypass-tunnel-reminder": "true",
};

interface PipelineRow {
  id: string;
  inventory_count_id: string;
  qb_account_list_id: string;
  status: string;
  qb_operation_id: string | null;
  qb_list_id: string | null; // QB TxnID once Add is synced — required to void
  retries: number;
  next_retry_at: Date | string | null;
  payload: PayloadShape;
  void_status: string | null;
  void_operation_id: string | null;
  void_retries: number;
  void_next_retry_at: Date | string | null;
}

interface PayloadShape {
  count_id: string;
  count_number: string;
  count_memo: string;
  qb_account_list_id: string;
  qb_inventory_site_list_id?: string;
  lines: Array<{
    line_id: string;
    inventory_item_id: string;
    product_variant_id: string;
    sku: string;
    delta_applied: number;
  }>;
}

// Default QB InventorySite ListID (Miami warehouse). Same constant as the
// other bridge builders use as fallback. Override per stock_location later
// via stock_location.metadata.qb_inventory_site_list_id.
const DEFAULT_QB_INVENTORY_SITE_LIST_ID = "80000001-1331053531";

interface BridgeEnqueueResponse {
  success: boolean;
  operationId?: string;
  status?: string;
  error?: string;
}

interface BridgeStatusResponse {
  operation?: {
    status?: "queued" | "processing" | "completed" | "failed";
    result?: any;
    error?: string;
    txnId?: string;
    refNumber?: string;
  };
}

/**
 * QB RefNumber max length is 11 chars. Sequences start at 1000 so we get
 * `IC1000` … `IC99999999` (room for plenty of growth). Falls back to a
 * truncated id if `count_number` is missing.
 */
function buildRefNumber(payload: PayloadShape): string {
  const num = payload.count_number || payload.count_id;
  // Strip the human-readable prefix and re-prefix as compact `IC{seq}`
  const match = num.match(/(\d+)$/);
  if (match) return `IC${match[1]}`.slice(0, 11);
  return num.slice(0, 11);
}

function buildMemo(payload: PayloadShape): string {
  const base = `Count ${payload.count_number}`;
  return payload.count_memo
    ? `${base} — ${payload.count_memo}`.slice(0, 4095)
    : base;
}

function nextBackoffDate(retries: number): Date {
  // 2^retries minutes, capped at 60 minutes
  const minutes = Math.min(60, 2 ** retries);
  return new Date(Date.now() + minutes * 60 * 1000);
}

function extractTxnId(data: BridgeStatusResponse): string | null {
  const op = data.operation;
  if (!op) return null;
  if (op.txnId) return op.txnId;
  const msgs = op.result?.QBXML?.QBXMLMsgsRs ?? op.result?.QBXMLMsgsRs ?? {};
  return msgs?.InventoryAdjustmentAddRs?.InventoryAdjustmentRet?.TxnID ?? null;
}

function extractTxnNumber(data: BridgeStatusResponse): string | null {
  const op = data.operation;
  if (op?.refNumber) return op.refNumber;
  const msgs = op?.result?.QBXML?.QBXMLMsgsRs ?? op?.result?.QBXMLMsgsRs ?? {};
  return (
    msgs?.InventoryAdjustmentAddRs?.InventoryAdjustmentRet?.TxnNumber ?? null
  );
}

async function postAdjustmentToBridge(args: {
  external_id: string;
  payload: PayloadShape;
  qbListIdsBySku: Map<string, string>;
}): Promise<BridgeEnqueueResponse> {
  const { external_id, payload, qbListIdsBySku } = args;

  const body = {
    external_id,
    ref_number: buildRefNumber(payload),
    memo: buildMemo(payload),
    txn_date: new Date().toISOString().slice(0, 10),
    account_list_id: payload.qb_account_list_id,
    inventory_site_list_id:
      payload.qb_inventory_site_list_id ?? DEFAULT_QB_INVENTORY_SITE_LIST_ID,
    lines: payload.lines.map((l) => ({
      qb_list_id: qbListIdsBySku.get(l.sku) as string,
      quantity_difference: l.delta_applied,
    })),
  };

  const res = await fetch(`${BRIDGE_URL}/api/inventory-adjustments`, {
    method: "POST",
    headers: { ...COMMON_HEADERS, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Bridge POST ${res.status}: ${text || "no body"}`);
  }
  return (await res.json()) as BridgeEnqueueResponse;
}

async function postVoidToBridge(args: {
  external_id: string;
  txn_id: string;
}): Promise<BridgeEnqueueResponse> {
  const res = await fetch(`${BRIDGE_URL}/api/inventory-adjustments/void`, {
    method: "POST",
    headers: { ...COMMON_HEADERS, "content-type": "application/json" },
    body: JSON.stringify({
      external_id: args.external_id,
      txn_id: args.txn_id,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Bridge VOID POST ${res.status}: ${text || "no body"}`);
  }
  return (await res.json()) as BridgeEnqueueResponse;
}

async function fetchBridgeStatus(
  operationId: string
): Promise<BridgeStatusResponse> {
  const res = await fetch(`${BRIDGE_URL}/api/sync/status/${operationId}`, {
    headers: COMMON_HEADERS,
  });
  if (!res.ok) {
    throw new Error(`Bridge status ${res.status}`);
  }
  return (await res.json()) as BridgeStatusResponse;
}

export default async function qbInventoryAdjustmentPoller(
  container: MedusaContainer
) {
  const logger = container.resolve("logger");
  const query = container.resolve(ContainerRegistrationKeys.QUERY);
  const inventoryCountSvc = container.resolve(INVENTORY_COUNT_MODULE) as any;

  const nowIso = new Date().toISOString();

  // ─── Load eligible rows (waiting OR error eligible for retry) ──────────────
  // Two independent lifecycles share the same row:
  //   `status`         drives the Add phase (initial sync to QB)
  //   `void_status`    drives the Void phase (reverse sync after manager voids)
  const { data: rows } = await query.graph({
    entity: "qb_inventory_adjustment_pipeline",
    fields: [
      "id",
      "inventory_count_id",
      "qb_account_list_id",
      "status",
      "qb_operation_id",
      "qb_list_id",
      "retries",
      "next_retry_at",
      "payload",
      "void_status",
      "void_operation_id",
      "void_retries",
      "void_next_retry_at",
    ],
    pagination: { skip: 0, take: MAX_ROWS_PER_TICK },
  });

  const isAddEligible = (r: PipelineRow): boolean => {
    if (r.status === "waiting") return true;
    if (r.status === "processing") return true;
    if (r.status === "error" && (r.retries ?? 0) < MAX_RETRIES) {
      const next = r.next_retry_at
        ? new Date(r.next_retry_at).toISOString()
        : null;
      return !next || next <= nowIso;
    }
    return false;
  };

  const isVoidEligible = (r: PipelineRow): boolean => {
    if (r.void_status === "waiting") return true;
    if (r.void_status === "processing") return true;
    if (r.void_status === "error" && (r.void_retries ?? 0) < MAX_RETRIES) {
      const next = r.void_next_retry_at
        ? new Date(r.void_next_retry_at).toISOString()
        : null;
      return !next || next <= nowIso;
    }
    return false;
  };

  const typedRows = rows as unknown as PipelineRow[];
  const eligibleAdd = typedRows.filter(isAddEligible);
  const eligibleVoid = typedRows.filter(isVoidEligible);

  if (eligibleAdd.length === 0 && eligibleVoid.length === 0) return;

  let sent = 0;
  let synced = 0;
  let errored = 0;
  let voidSent = 0;
  let voidSynced = 0;
  let voidErrored = 0;
  const eligible = eligibleAdd; // alias for the existing Add loop below

  for (const row of eligible) {
    try {
      // ─── POLL PHASE ────────────────────────────────────────────────────────
      if (row.qb_operation_id && row.status === "processing") {
        const data = await fetchBridgeStatus(row.qb_operation_id);
        const status = data.operation?.status;

        if (status === "completed") {
          const txnId = extractTxnId(data);
          const txnNumber = extractTxnNumber(data);
          if (!txnId) {
            await inventoryCountSvc.updateQbInventoryAdjustmentPipelines({
              id: row.id,
              status: "error",
              last_error: "Completed but no TxnID in response",
              retries: (row.retries ?? 0) + 1,
              next_retry_at: nextBackoffDate((row.retries ?? 0) + 1),
            });
            errored++;
            continue;
          }
          await inventoryCountSvc.updateQbInventoryAdjustmentPipelines({
            id: row.id,
            status: "synced",
            qb_list_id: txnId,
            qb_txn_number: txnNumber,
            synced_at: new Date(),
          });
          await inventoryCountSvc.updateInventoryCounts({
            id: row.inventory_count_id,
            qb_synced_at: new Date(),
          });
          synced++;
          continue;
        }

        if (status === "failed") {
          await inventoryCountSvc.updateQbInventoryAdjustmentPipelines({
            id: row.id,
            status: "error",
            last_error: data.operation?.error ?? "Bridge returned failed",
            retries: (row.retries ?? 0) + 1,
            next_retry_at: nextBackoffDate((row.retries ?? 0) + 1),
          });
          errored++;
          continue;
        }

        // queued/processing → leave as-is and check next tick
        continue;
      }

      // ─── SEND PHASE ────────────────────────────────────────────────────────
      const payload = row.payload;
      if (
        !payload ||
        !Array.isArray(payload.lines) ||
        payload.lines.length === 0
      ) {
        await inventoryCountSvc.updateQbInventoryAdjustmentPipelines({
          id: row.id,
          status: "error",
          last_error: "Pipeline payload missing or empty",
        });
        errored++;
        continue;
      }

      // Resolve qb_list_id for each variant. Two sources, in priority order:
      //   1. qb_item_pipeline (status=synced) — the modern POS Product Creation V2 sync table
      //   2. product_variant.metadata.quickbooks_id — legacy items (the bulk imported from QB)
      // Most variants in this codebase fall under #2 (~2555 of 2564), so the
      // fallback is critical, not optional.
      const skus = payload.lines.map((l) => l.sku);
      const qbListIdsBySku = new Map<string, string>();

      const { data: itemRows } = await query.graph({
        entity: "qb_item_pipeline",
        fields: ["sku", "qb_list_id", "status"],
        filters: { sku: skus, status: "synced" } as any,
        pagination: { skip: 0, take: skus.length },
      });
      for (const r of itemRows as Array<{
        sku: string;
        qb_list_id: string | null;
      }>) {
        if (r.qb_list_id) qbListIdsBySku.set(r.sku, r.qb_list_id);
      }

      const stillMissing = payload.lines.filter(
        (l) => !qbListIdsBySku.has(l.sku)
      );
      if (stillMissing.length > 0) {
        const { data: variantRows } = await query.graph({
          entity: "product_variant",
          fields: ["id", "sku", "metadata"],
          filters: { id: stillMissing.map((l) => l.product_variant_id) } as any,
          pagination: { skip: 0, take: stillMissing.length },
        });
        for (const v of variantRows as Array<{
          sku: string | null;
          metadata: Record<string, unknown> | null;
        }>) {
          const qbId = v.metadata?.quickbooks_id;
          if (typeof qbId === "string" && qbId.length > 0 && v.sku) {
            qbListIdsBySku.set(v.sku, qbId);
          }
        }
      }

      const missing = payload.lines.filter((l) => !qbListIdsBySku.has(l.sku));
      if (missing.length > 0) {
        const skuList = missing
          .map((m) => m.sku)
          .slice(0, 10)
          .join(", ");
        await inventoryCountSvc.updateQbInventoryAdjustmentPipelines({
          id: row.id,
          status: "error",
          last_error: `${missing.length} item(s) have no QB ListID (neither in qb_item_pipeline nor variant.metadata.quickbooks_id): ${skuList}`,
          retries: (row.retries ?? 0) + 1,
          next_retry_at: nextBackoffDate((row.retries ?? 0) + 1),
        });
        errored++;
        continue;
      }

      const enqueued = await postAdjustmentToBridge({
        external_id: row.id,
        payload,
        qbListIdsBySku,
      });

      if (!enqueued.success || !enqueued.operationId) {
        throw new Error(
          enqueued.error ?? "Bridge enqueue failed without operationId"
        );
      }

      await inventoryCountSvc.updateQbInventoryAdjustmentPipelines({
        id: row.id,
        status: "processing",
        qb_operation_id: enqueued.operationId,
        last_error: null,
      });
      sent++;
    } catch (err: any) {
      await inventoryCountSvc.updateQbInventoryAdjustmentPipelines({
        id: row.id,
        status: "error",
        last_error: err.message,
        retries: (row.retries ?? 0) + 1,
        next_retry_at: nextBackoffDate((row.retries ?? 0) + 1),
      });
      errored++;
      logger.warn(`[qb-inv-adj-poller] row ${row.id} failed: ${err.message}`);
    }
  }

  // ─── VOID LOOP ───────────────────────────────────────────────────────────
  for (const row of eligibleVoid) {
    try {
      // Void POLL phase
      if (row.void_operation_id && row.void_status === "processing") {
        const data = await fetchBridgeStatus(row.void_operation_id);
        const status = data.operation?.status;

        if (status === "completed") {
          await inventoryCountSvc.updateQbInventoryAdjustmentPipelines({
            id: row.id,
            void_status: "voided",
            void_synced_at: new Date(),
          });
          voidSynced++;
          continue;
        }
        if (status === "failed") {
          await inventoryCountSvc.updateQbInventoryAdjustmentPipelines({
            id: row.id,
            void_status: "error",
            void_last_error: data.operation?.error ?? "Bridge returned failed",
            void_retries: (row.void_retries ?? 0) + 1,
            void_next_retry_at: nextBackoffDate((row.void_retries ?? 0) + 1),
          });
          voidErrored++;
          continue;
        }
        // queued/processing → wait next tick
        continue;
      }

      // Void SEND phase: requires the original Add to have produced a TxnID.
      if (!row.qb_list_id) {
        await inventoryCountSvc.updateQbInventoryAdjustmentPipelines({
          id: row.id,
          void_status: "error",
          void_last_error:
            "Cannot void: no qb_list_id (original adjustment never reached QB)",
          void_retries: (row.void_retries ?? 0) + 1,
          void_next_retry_at: nextBackoffDate((row.void_retries ?? 0) + 1),
        });
        voidErrored++;
        continue;
      }

      const enqueued = await postVoidToBridge({
        external_id: row.id,
        txn_id: row.qb_list_id,
      });
      if (!enqueued.success || !enqueued.operationId) {
        throw new Error(
          enqueued.error ?? "Bridge void enqueue failed without operationId"
        );
      }

      await inventoryCountSvc.updateQbInventoryAdjustmentPipelines({
        id: row.id,
        void_status: "processing",
        void_operation_id: enqueued.operationId,
        void_last_error: null,
      });
      voidSent++;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "unknown error";
      await inventoryCountSvc.updateQbInventoryAdjustmentPipelines({
        id: row.id,
        void_status: "error",
        void_last_error: message,
        void_retries: (row.void_retries ?? 0) + 1,
        void_next_retry_at: nextBackoffDate((row.void_retries ?? 0) + 1),
      });
      voidErrored++;
      logger.warn(`[qb-inv-adj-poller] void row ${row.id} failed: ${message}`);
    }
  }

  if (sent || synced || errored) {
    logger.info(
      `[qb-inv-adj-poller] tick: sent=${sent} synced=${synced} errored=${errored} of ${eligibleAdd.length}`
    );
  }
  if (voidSent || voidSynced || voidErrored) {
    logger.info(
      `[qb-inv-adj-poller] void tick: sent=${voidSent} synced=${voidSynced} errored=${voidErrored} of ${eligibleVoid.length}`
    );
  }
}

export const config = {
  name: "qb-inventory-adjustment-poller",
  schedule: "*/1 * * * *",
};

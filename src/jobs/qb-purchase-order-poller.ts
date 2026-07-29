/**
 * src/jobs/qb-purchase-order-poller.ts
 *
 * Three-phase cron job for syncing submitted POs to QuickBooks Desktop.
 *
 * Phase A — Submit: rows status='waiting', qb_operation_id IS NULL
 *   → POST /api/purchase-orders to the bridge → store operationId.
 *
 * Phase B — Poll: rows status='waiting', qb_operation_id IS NOT NULL
 *   → GET /api/sync/status/:opId → if completed, extract TxnID,
 *     update PO header (qb_purchase_order_list_id, qb_synced_at), mark synced.
 *
 * Phase C — Retry: rows status='error', next_retry_at <= now
 *   → re-submit payload to bridge, store new operationId, reset status='waiting'.
 *
 * Runs every minute. MAX_ROWS_PER_TICK=30 per phase.
 */

import { MedusaContainer } from "@medusajs/framework/types";
import { pollBridgeStatus } from "../lib/quickbooks/bridge-fetch";
import {
  bridgeFetch,
  POLL_INTERVAL_MS,
  MAX_POLL_ATTEMPTS,
} from "../lib/quickbooks/client/core";
import {
  markStaleRowsAsFailed,
  STANDARD_STALE_CONFIG,
} from "../lib/quickbooks/stale-row-cleanup";
import { classifyQbError } from "../lib/quickbooks/error-classifier";
import { isScheduledJobsDisabled } from "./_lib/_scheduled-jobs-guard";
import {
  orderPurchaseOrderModLines,
  type PurchaseOrderModLineLike,
} from "../lib/quickbooks/purchase-order-line-order";
import { requireBridgeUrl } from "../lib/quickbooks/bridge-url";

const bridgeUrl = (): string =>
  requireBridgeUrl();
const apiKey = (): string => process.env.QB_API_KEY || "";
const MAX_ROWS_PER_TICK = 30;
const MAX_RETRIES = 5;
const RETRY_BACKOFF_MIN: readonly number[] = [2, 4, 10, 30, 60] as const;
const FIRST_ERROR_BACKOFF_MIN = 2;

const backoffMs = (retryNum: number): number =>
  (RETRY_BACKOFF_MIN[Math.min(retryNum, RETRY_BACKOFF_MIN.length - 1)] ??
    FIRST_ERROR_BACKOFF_MIN) * 60_000;

const withCanonicalPoMemo = (
  payload: Record<string, unknown>
): Record<string, unknown> => {
  const poNumber = payload.po_number;
  if (typeof poNumber !== "string" || poNumber.length === 0) return payload;
  return { ...payload, memo: `Medusa PO ${poNumber.replace(/^PO-/i, "")}` };
};

type BridgeStatus = {
  operation?: {
    status?: "queued" | "processing" | "completed" | "failed" | "expired";
    error?: string;
    txnId?: string;
    listId?: string;
    refNumber?: string;
    editSequence?: string;
    result?: unknown;
  };
};

const pollBridge = async (operationId: string): Promise<BridgeStatus> => {
  // Use centralized helper that maps HTTP 404 → synthetic "expired" status.
  // Why: a 404 means the bridge no longer knows about this op (queue cleaned,
  // bridge restart, completed-and-purged). Treating it as fatal kept rows stuck
  // in `submitted` indefinitely (incident PO-1015/PO-1016, 2026-04-29).
  const result = await pollBridgeStatus(operationId);
  if (result.status === "expired") {
    return {
      operation: {
        status: "expired",
        error:
          "Bridge operation expired (HTTP 404). Op no longer in bridge queue.",
      },
    } as BridgeStatus;
  }
  return result.data as BridgeStatus;
};

const submitQueryToBridge = async (
  payload: Record<string, unknown>
): Promise<string> => {
  const res = await fetch(`${bridgeUrl()}/api/purchase-orders/query`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey(),
      "bypass-tunnel-reminder": "true",
    },
    body: JSON.stringify({ txn_id: payload.txn_id, po_id: payload.po_id }),
  });
  if (!res.ok)
    throw new Error(`Bridge HTTP ${res.status} — ${await res.text()}`);
  const json = (await res.json()) as { operationId?: string; error?: string };
  if (!json.operationId)
    throw new Error(json.error ?? "Bridge returned no operationId");
  return json.operationId;
};

const submitVoidToBridge = async (
  payload: Record<string, unknown>
): Promise<string> => {
  const body = withCanonicalPoMemo(payload);
  const res = await fetch(`${bridgeUrl()}/api/purchase-orders/void`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey(),
      "bypass-tunnel-reminder": "true",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok)
    throw new Error(`Bridge HTTP ${res.status} — ${await res.text()}`);
  const json = (await res.json()) as { operationId?: string; error?: string };
  if (!json.operationId)
    throw new Error(json.error ?? "Bridge returned no operationId");
  return json.operationId;
};

const submitModToBridge = async (
  payload: Record<string, unknown>
): Promise<string> => {
  const sortedLines = Array.isArray(payload.lines)
    ? orderPurchaseOrderModLines(
        payload.lines as Array<
          PurchaseOrderModLineLike & Record<string, unknown>
        >
      )
    : undefined;
  const body = withCanonicalPoMemo({
    ...payload,
    ...(sortedLines ? { lines: sortedLines } : {}),
  });
  const res = await fetch(`${bridgeUrl()}/api/purchase-orders/mod`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey(),
      "bypass-tunnel-reminder": "true",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok)
    throw new Error(`Bridge HTTP ${res.status} — ${await res.text()}`);
  const json = (await res.json()) as { operationId?: string; error?: string };
  if (!json.operationId)
    throw new Error(json.error ?? "Bridge returned no operationId");
  return json.operationId;
};

const submitToBridge = async (
  payload: Record<string, unknown>
): Promise<string> => {
  const body = withCanonicalPoMemo(payload);
  const res = await fetch(`${bridgeUrl()}/api/purchase-orders`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey(),
      "bypass-tunnel-reminder": "true",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok)
    throw new Error(`Bridge HTTP ${res.status} — ${await res.text()}`);
  const json = (await res.json()) as { operationId?: string; error?: string };
  if (!json.operationId)
    throw new Error(json.error ?? "Bridge returned no operationId");
  return json.operationId;
};

const extractPoRet = (data: BridgeStatus): any => {
  const op = data.operation;
  if (!op) return null;
  const msgs =
    (op.result as any)?.QBXML?.QBXMLMsgsRs ??
    (op.result as any)?.QBXMLMsgsRs ??
    {};
  const ret =
    msgs?.PurchaseOrderAddRs?.PurchaseOrderRet ??
    msgs?.PurchaseOrderModRs?.PurchaseOrderRet ??
    msgs?.PurchaseOrderQueryRs?.PurchaseOrderRet ??
    null;
  // QB query responses may return an array when multiple POs match
  return Array.isArray(ret) ? (ret[0] ?? null) : ret;
};

// Extract QB-side error from a QBXML response. The bridge can briefly mark an
// operation as "completed" (QBXML round-trip succeeded) while the embedded
// QBXML response itself is an error (statusCode != "0"). Without this check
// the poller falls through to the success path and falsely marks the row as
// synced. Returns the QB error message if any *Rs has non-zero statusCode.
const extractQbResponseError = (data: BridgeStatus): string | null => {
  const op = data.operation;
  if (!op) return null;
  const msgs =
    (op.result as any)?.QBXML?.QBXMLMsgsRs ??
    (op.result as any)?.QBXMLMsgsRs ??
    null;
  if (!msgs) return null;
  for (const key of [
    "PurchaseOrderAddRs",
    "PurchaseOrderModRs",
    "PurchaseOrderQueryRs",
  ]) {
    const rs = (msgs as any)[key];
    if (!rs) continue;
    const code = String(rs.statusCode ?? rs["@statusCode"] ?? "0");
    if (code !== "0") {
      const msg = rs.statusMessage ?? rs["@statusMessage"] ?? `QB ${key} statusCode=${code}`;
      return `QuickBooks Error ${code}: ${msg}`;
    }
  }
  return null;
};

const extractTxnId = (data: BridgeStatus): string | null => {
  const op = data.operation;
  if (!op) return null;
  if (op.txnId) return op.txnId;
  if (op.listId) return op.listId;
  return extractPoRet(data)?.TxnID ?? null;
};

const extractRefNumber = (data: BridgeStatus): string | null => {
  const op = data.operation;
  if (op?.refNumber) return op.refNumber;
  return extractPoRet(data)?.RefNumber ?? null;
};

const extractEditSequence = (data: BridgeStatus): string | null => {
  const op = data.operation;
  if (op?.editSequence) return op.editSequence;
  return extractPoRet(data)?.EditSequence ?? null;
};

const extractTxnLineIds = (data: BridgeStatus): string[] => {
  const ret = extractPoRet(data);
  if (!ret) return [];
  const lineRets = ret.PurchaseOrderLineRet;
  if (!lineRets) return [];
  const arr = Array.isArray(lineRets) ? lineRets : [lineRets];
  return arr.map((l: any) => l.TxnLineID ?? "").filter(Boolean);
};

// Returns SKU/ListID-keyed line metadata from a QB PurchaseOrderRet, used by
// the line-recovery path to re-map qb_txn_line_id on each purchase_order_line
// row by SKU instead of positional index. SKU match is the canonical key
// because QB will reorder lines on Mod and positional matching is unsafe.
const extractLineMetaBySku = (
  data: BridgeStatus
): Array<{ sku: string; listId: string | null; txnLineId: string }> => {
  const ret = extractPoRet(data);
  if (!ret) return [];
  const lineRets = ret.PurchaseOrderLineRet;
  if (!lineRets) return [];
  const arr = Array.isArray(lineRets) ? lineRets : [lineRets];
  return arr
    .map((l: any) => ({
      sku: (l.ItemRef?.FullName ?? "") as string,
      listId: (l.ItemRef?.ListID ?? null) as string | null,
      txnLineId: (l.TxnLineID ?? "") as string,
    }))
    .filter((r) => r.sku && r.txnLineId);
};

/**
 * Fallback PO lookup by RefNumber via /api/sync/direct-query.
 *
 * Why: the regular /api/purchase-orders/query endpoint searches by TxnID, which
 * can fail spuriously after a bridge restart or when the local QB cache is
 * stale, even though the PO still exists in QuickBooks. Querying by RefNumber
 * (the human-visible "P.O. No.") is a more robust way to recover the current
 * TxnID + EditSequence and avoid escalating recoverable conditions to
 * `failed_permanent`.
 *
 * Returns null if the bridge can't reach QB or the PO truly doesn't exist.
 * Throws on bridge errors so the caller can decide whether to retry later.
 */
const lookupPoByRefNumber = async (
  refNumber: string
): Promise<{ txnId: string; editSequence: string } | null> => {
  const qbxml = [
    `<?xml version="1.0" encoding="utf-8"?>`,
    `<?qbxml version="10.0"?>`,
    `<QBXML><QBXMLMsgsRq onError="stopOnError">`,
    `<PurchaseOrderQueryRq requestID="1">`,
    `<RefNumber>${refNumber}</RefNumber>`,
    `</PurchaseOrderQueryRq>`,
    `</QBXMLMsgsRq></QBXML>`,
  ].join("");

  const enqueueRes = (await bridgeFetch("POST", "/api/sync/direct-query", {
    qbxml,
  })) as { operationId?: string; operation_id?: string };
  const operationId = enqueueRes?.operationId || enqueueRes?.operation_id;
  if (!operationId) throw new Error("Bridge did not return operationId");

  for (let attempt = 1; attempt <= MAX_POLL_ATTEMPTS; attempt++) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const statusRes = (await bridgeFetch(
      "GET",
      `/api/sync/status/${operationId}`
    )) as {
      operation?: { status?: string; result?: unknown; error?: string };
    };
    const op = statusRes?.operation;
    if (!op) continue;
    if (op.status === "completed") {
      const result = op.result as Record<string, unknown>;
      const msgs: any =
        (result as any)?.QBXML?.QBXMLMsgsRs ??
        (result as any)?.QBXMLMsgsRs ??
        result;
      const retRaw =
        msgs?.PurchaseOrderQueryRs?.PurchaseOrderRet ??
        (result as any)?.PurchaseOrderRet ??
        null;
      if (!retRaw) return null;
      const doc = (Array.isArray(retRaw) ? retRaw[0] : retRaw) as Record<
        string,
        string
      >;
      const txnId = doc?.TxnID || "";
      const editSequence = doc?.EditSequence || "";
      if (!txnId || !editSequence) return null;
      return { txnId, editSequence };
    }
    if (op.status === "failed") {
      throw new Error(
        `Bridge direct-query failed: ${op.error || "Unknown error"}`
      );
    }
  }
  throw new Error(
    "Bridge direct-query timed out — QuickBooks Desktop may be offline or QBWC not connected"
  );
};

export default async function qbPurchaseOrderPoller(
  container: MedusaContainer
) {
  if (isScheduledJobsDisabled(container)) return;

  const logger = container.resolve("logger") as any;
  const knex = (container as any).resolve("__pg_connection__");

  const TAG = "[qb-po-poller]";

  // Safety net: demote rows stuck in waiting/submitted past their thresholds
  // (in case the consolidator is delayed or the bridge dropped operations).
  await markStaleRowsAsFailed(
    knex,
    "qb_purchase_order_pipeline",
    STANDARD_STALE_CONFIG,
    { warn: (m) => logger.warn?.(`${TAG} ${m}`) },
    `AND NOT (
       COALESCE(payload->>'is_mod', 'false') = 'true'
       AND (
         order_pipeline_id IS NOT NULL
         OR COALESCE(payload->>'delegated_to_consolidator', 'false') = 'true'
       )
     )`
  );

  let submitted = 0;
  let resolved = 0;
  let toError = 0;
  let retried = 0;
  let permaFailed = 0;

  // ── Phase A: Submit unsubmitted waiting rows ─────────────────────────────
  const unsubmitted: any[] = await knex
    .raw(
      `SELECT id, purchase_order_id, payload
       FROM qb_purchase_order_pipeline
      WHERE status = 'waiting'
        AND qb_operation_id IS NULL
        AND NOT (
          COALESCE(payload->>'is_mod', 'false') = 'true'
          AND (
            order_pipeline_id IS NOT NULL
            OR COALESCE(payload->>'delegated_to_consolidator', 'false') = 'true'
          )
        )
        AND deleted_at IS NULL
      LIMIT ?`,
      [MAX_ROWS_PER_TICK]
    )
    .then((r: any) => r.rows);

  if (unsubmitted.length > 0) {
    logger.info(
      `${TAG} phase A: submitting ${unsubmitted.length} unsubmitted rows`
    );
  }

  for (const row of unsubmitted) {
    try {
      let pl = row.payload as Record<string, unknown>;
      let operationId: string;

      if (pl.is_void && !pl.is_query) {
        // Void PO — needs edit_sequence; query QB first if missing
        if (!pl.edit_sequence) {
          pl = { ...pl, is_query: true };
          await knex.raw(
            `UPDATE qb_purchase_order_pipeline SET payload = ?, updated_at = NOW() WHERE id = ?`,
            [JSON.stringify(pl), row.id]
          );
          operationId = await submitQueryToBridge(pl);
          logger.info(`${TAG} row ${row.id}: void needs edit_sequence, querying QB first`);
        } else {
          operationId = await submitVoidToBridge(pl);
        }
      } else if (pl.is_mod && !pl.edit_sequence) {
        // No EditSequence — query QB first, then retry mod with fresh sequence
        pl = { ...pl, is_query: true };
        await knex.raw(
          `UPDATE qb_purchase_order_pipeline SET payload = ?, updated_at = NOW() WHERE id = ?`,
          [JSON.stringify(pl), row.id]
        );
        operationId = await submitQueryToBridge(pl);
        logger.info(
          `${TAG} row ${row.id}: no edit_sequence, querying QB first`
        );
      } else if (pl.is_query) {
        operationId = await submitQueryToBridge(pl);
      } else if (pl.is_mod) {
        operationId = await submitModToBridge(pl);
      } else {
        // Guard: if the PO already has a QB TxnID in our DB, a previous attempt
        // succeeded but the pipeline row was never marked synced. Mark it now
        // instead of creating a duplicate PO in QB.
        const existing = await knex
          .raw(
            `SELECT qb_purchase_order_list_id FROM purchase_order WHERE id = ? LIMIT 1`,
            [row.purchase_order_id]
          )
          .then((r: any) => r.rows[0]);
        if (existing?.qb_purchase_order_list_id) {
          await knex.raw(
            `UPDATE qb_purchase_order_pipeline
                SET status = 'synced', qb_list_id = ?, last_error = NULL,
                    next_retry_at = NULL, synced_at = NOW(), updated_at = NOW()
              WHERE id = ?`,
            [existing.qb_purchase_order_list_id, row.id]
          );
          resolved++;
          logger.info(
            `${TAG} row ${row.id}: PO already in QB (${existing.qb_purchase_order_list_id}), marked synced without re-create`
          );
          continue;
        }
        operationId = await submitToBridge(pl);
      }

      await knex.raw(
        `UPDATE qb_purchase_order_pipeline
            SET status = 'submitted', qb_operation_id = ?, updated_at = NOW()
          WHERE id = ?`,
        [operationId, row.id]
      );
      submitted++;
    } catch (err: any) {
      await knex.raw(
        `UPDATE qb_purchase_order_pipeline
            SET status = 'error',
                last_error = ?,
                next_retry_at = NOW() + INTERVAL '${FIRST_ERROR_BACKOFF_MIN} minutes',
                updated_at = NOW()
          WHERE id = ?`,
        [err.message, row.id]
      );
      toError++;
      logger.error(`${TAG} submit failed for row ${row.id}: ${err.message}`);
    }
  }

  // ── Phase B: Poll submitted rows ─────────────────────────────────────────
  const polling: any[] = await knex
    .raw(
      `SELECT id, purchase_order_id, qb_operation_id, qb_list_id, payload
       FROM qb_purchase_order_pipeline
      WHERE status = 'submitted'
        AND NOT (
          COALESCE(payload->>'is_mod', 'false') = 'true'
          AND (
            order_pipeline_id IS NOT NULL
            OR COALESCE(payload->>'delegated_to_consolidator', 'false') = 'true'
          )
        )
        AND deleted_at IS NULL
      LIMIT ?`,
      [MAX_ROWS_PER_TICK]
    )
    .then((r: any) => r.rows);

  if (polling.length > 0) {
    logger.info(`${TAG} phase B: polling ${polling.length} submitted rows`);
  }

  for (const row of polling) {
    try {
      const data = await pollBridge(row.qb_operation_id);
      let opStatus = data.operation?.status;

      if (!opStatus || opStatus === "queued" || opStatus === "processing")
        continue;

      // Defensive: any status outside the 4 documented final values means the
      // bridge is in an unknown state. Skip this tick rather than fall through
      // to the success path. Only "completed" / "failed" / "expired" are
      // handled below.
      if (
        opStatus !== "completed" &&
        opStatus !== "failed" &&
        opStatus !== "expired"
      ) {
        logger.warn(
          `${TAG} row ${row.id}: unknown bridge opStatus="${opStatus}" — skipping`
        );
        continue;
      }

      // Bridge says "completed" but attached an error → QB call returned a
      // soft error (e.g. EditSequence 3200 or item-list mismatch). The MOD
      // was NOT applied. Treat this exactly like opStatus === "failed" so
      // the EditSeq re-query path fires instead of falsely marking the
      // pipeline synced. Without this guard, the back-fill block below
      // uses row.qb_list_id as a fallback TxnID and writes synced_at,
      // leaving the pipeline lying about a Mod that never reached QB.
      //
      // Two flavours of "completed-but-failed":
      //   1. data.operation.error is populated by the bridge after retry.
      //   2. data.operation.error is empty BUT the embedded QBXML response
      //      has statusCode != "0" (Add/Mod/Query Rs). The bridge marks the
      //      QBXML round-trip as completed even when QB itself returned an
      //      error. Without inspecting statusCode, errors like 3120 (object
      //      not found) and 3200 (stale EditSequence) sneak past as success.
      if (opStatus === "completed") {
        const embeddedErr =
          data.operation?.error ?? extractQbResponseError(data);
        if (embeddedErr) {
          (data.operation as any) = {
            ...(data.operation ?? {}),
            error: embeddedErr,
          };
          opStatus = "failed";
        }
      }

      if (opStatus === "expired") {
        // Bridge no longer knows the op. Clear op_id, mark as error, retry shortly.
        await knex.raw(
          `UPDATE qb_purchase_order_pipeline
           SET status = 'error',
               last_error = ?,
               qb_operation_id = NULL,
               next_retry_at = NOW() + INTERVAL '2 minutes',
               updated_at = NOW()
           WHERE id = ?`,
          [data.operation?.error ?? "Bridge operation expired", row.id]
        );
        continue;
      }

      if (opStatus === "failed") {
        const errMsg = data.operation?.error ?? "Bridge returned failed";
        const pl = row.payload as Record<string, unknown>;

        // QB Error 3120: "Object … cannot be found" — usually means a TxnLineID
        // we sent doesn't exist in QB (line IDs went stale). Recovery: re-query
        // QB with IncludeLineItems and re-map qb_txn_line_id by SKU before
        // retrying the Mod. The query path already requests IncludeLineItems=1;
        // we just need to flag the row so Phase B's query handler knows to
        // overwrite line TxnLineIDs by SKU (not positional) before re-queueing.
        const isLineIdMissingErr = /3120|object.*cannot be found|invalid reference/i.test(errMsg);
        if ((pl.is_mod || pl.is_void) && !pl.is_query && isLineIdMissingErr) {
          const freshPl = {
            ...pl,
            is_query: true,
            edit_sequence: undefined,
            _needs_line_recovery: true,
          };
          await knex.raw(
            `UPDATE qb_purchase_order_pipeline
                SET status = 'waiting',
                    qb_operation_id = NULL,
                    payload = ?,
                    last_error = ?,
                    next_retry_at = NULL,
                    updated_at = NOW()
              WHERE id = ?`,
            [JSON.stringify(freshPl), errMsg, row.id]
          );
          logger.warn(
            `${TAG} row ${row.id}: stale TxnLineID (${errMsg.slice(0, 80)}) → re-query QB with line recovery`
          );
          continue;
        }

        // Stale/missing EditSequence (QB status 3100/3200 or message text) → re-query QB, then retry mod/void
        const isEditSeqErr = /editsequence|edit.?sequence|3[12]00|po not found in qb|may have been deleted/i.test(errMsg);
        if ((pl.is_mod || pl.is_void) && !pl.is_query && isEditSeqErr) {
          const freshPl = { ...pl, is_query: true, edit_sequence: undefined };
          await knex.raw(
            `UPDATE qb_purchase_order_pipeline
                SET status = 'waiting',
                    qb_operation_id = NULL,
                    payload = ?,
                    last_error = ?,
                    next_retry_at = NULL,
                    updated_at = NOW()
              WHERE id = ?`,
            [JSON.stringify(freshPl), errMsg, row.id]
          );
          logger.warn(
            `${TAG} row ${row.id}: EditSequence error → will re-query QB`
          );
          continue;
        }

        await knex.raw(
          `UPDATE qb_purchase_order_pipeline
              SET status = 'error',
                  last_error = ?,
                  next_retry_at = NOW() + INTERVAL '${FIRST_ERROR_BACKOFF_MIN} minutes',
                  updated_at = NOW()
            WHERE id = ?`,
          [errMsg, row.id]
        );
        toError++;
        continue;
      }

      // completed
      const pl = row.payload as Record<string, unknown>;
      const refNumber = extractRefNumber(data);
      const editSequence = extractEditSequence(data);
      const txnLineIds = extractTxnLineIds(data);
      // For query ops the TxnID is already known from the payload; don't require it from QB response.
      // For MOD ops the PO already exists in QB — fall back to the row's stored qb_list_id.
      const txnId =
        extractTxnId(data) ??
        (pl.is_query ? (pl.txn_id as string | null) : null) ??
        (pl.is_mod ? (row.qb_list_id as string | null) : null);
      if (!txnId) {
        // Bridge result may have been stripped after a restart — re-query QB to recover.
        if ((pl.is_mod || pl.is_void) && !pl.is_query && pl.txn_id) {
          const freshPl = { ...pl, is_query: true, edit_sequence: undefined };
          await knex.raw(
            `UPDATE qb_purchase_order_pipeline
                SET status = 'waiting',
                    qb_operation_id = NULL,
                    payload = ?,
                    next_retry_at = NULL,
                    updated_at = NOW()
              WHERE id = ?`,
            [JSON.stringify(freshPl), row.id]
          );
          logger.warn(`${TAG} row ${row.id}: completed but no TxnID → re-querying QB for current state`);
          continue;
        }
        await knex.raw(
          `UPDATE qb_purchase_order_pipeline
              SET status = 'error',
                  last_error = 'Completed but no TxnID in response',
                  next_retry_at = NOW() + INTERVAL '${FIRST_ERROR_BACKOFF_MIN} minutes',
                  updated_at = NOW()
            WHERE id = ?`,
          [row.id]
        );
        toError++;
        continue;
      }

      // Always back-fill PO header with latest QB data
      await knex.raw(
        `UPDATE purchase_order
            SET qb_purchase_order_list_id = ?,
                qb_purchase_order_txn_number = COALESCE(?, qb_purchase_order_txn_number),
                qb_edit_sequence = COALESCE(?, qb_edit_sequence),
                qb_synced_at = NOW(),
                updated_at = NOW()
          WHERE id = ?`,
        [txnId, refNumber, editSequence, row.purchase_order_id]
      );

      // Back-fill TxnLineIDs on lines (positional match against payload lines)
      if (txnLineIds.length > 0) {
        const payloadLines =
          (pl?.lines as Array<{ line_id?: string }> | undefined) ?? [];
        for (
          let i = 0;
          i < Math.min(txnLineIds.length, payloadLines.length);
          i++
        ) {
          const lineId = payloadLines[i]?.line_id;
          if (lineId && txnLineIds[i]) {
            await knex.raw(
              `UPDATE purchase_order_line SET qb_txn_line_id = ?, updated_at = NOW() WHERE id = ?`,
              [txnLineIds[i], lineId]
            );
          }
        }
      }

      // Query-before-mod/void: reset this row to a pending mod or void with the fresh EditSequence
      if (pl.is_query && (pl.is_mod || pl.is_void)) {
        const poRet = extractPoRet(data);
        const isManuallyClosed = poRet?.IsManuallyClosed === 'true';

        // Line recovery: when the previous Mod attempt failed with QB 3120
        // (object not found), the qb_txn_line_id values in DB are stale.
        // Now that the query came back with the current line items, re-map
        // by SKU and overwrite DB so the next Mod sends the real TxnLineIDs.
        // Then rebuild the payload's lines from DB so the retry uses fresh
        // data. SKU is the canonical key — positional matching is unsafe
        // because QB can reorder lines across Mod operations.
        if (pl._needs_line_recovery && poRet) {
          const meta = extractLineMetaBySku(data);
          if (meta.length > 0) {
            for (const m of meta) {
              await knex.raw(
                `UPDATE purchase_order_line
                    SET qb_txn_line_id = ?, updated_at = NOW()
                  WHERE purchase_order_id = ?
                    AND sku_snapshot = ?`,
                [m.txnLineId, row.purchase_order_id, m.sku]
              );
            }
            logger.info(
              `${TAG} row ${row.id}: line recovery re-mapped ${meta.length} TxnLineIDs by SKU`
            );
          }
        }

        // PO already closed in QB — void is a no-op, mark synced instead of error
        if (pl.is_void && isManuallyClosed) {
          await knex.raw(
            `UPDATE qb_purchase_order_pipeline
                SET status = 'synced', last_error = NULL, next_retry_at = NULL,
                    synced_at = NOW(), updated_at = NOW()
              WHERE id = ?`,
            [row.id]
          );
          resolved++;
          logger.info(
            `${TAG} row ${row.id}: PO already closed in QB (IsManuallyClosed) — void is a no-op, marked synced`
          );
          continue;
        }

        if (!editSequence) {
          if (!poRet) {
            // poRet is null either because the PO was deleted from QB, or because the bridge
            // restarted and stripped the result. Re-queue up to 3 times before giving up.
            const queryAttempts = ((pl._query_attempts as number) ?? 0) + 1;
            if (queryAttempts <= 3) {
              const requeuePl = { ...pl, is_query: true, edit_sequence: undefined, _query_attempts: queryAttempts };
              await knex.raw(
                `UPDATE qb_purchase_order_pipeline
                    SET status = 'waiting',
                        qb_operation_id = NULL,
                        payload = ?,
                        updated_at = NOW()
                  WHERE id = ?`,
                [JSON.stringify(requeuePl), row.id]
              );
              logger.warn(`${TAG} row ${row.id}: no poRet in query response (attempt ${queryAttempts}/3) — re-querying QB`);
              continue;
            }

            // RefNumber fallback: TxnID-based query keeps failing — try by RefNumber via direct-query.
            // The PO may simply have a stale cached entry on the bridge side, or someone re-saved
            // it in QB Desktop (which leaves the TxnID intact but the bridge sometimes can't find
            // it via the targeted endpoint). RefNumber lookup tends to work in those cases.
            const refRecoveryAttempts =
              ((pl._refnumber_recovery_attempts as number) ?? 0) + 1;
            if (refRecoveryAttempts <= 1) {
              const poRow = (await knex
                .raw(
                  `SELECT qb_purchase_order_txn_number, qb_purchase_order_list_id
                     FROM purchase_order
                    WHERE id = ?
                    LIMIT 1`,
                  [row.purchase_order_id]
                )
                .then((r: any) => r.rows[0])) as
                | {
                    qb_purchase_order_txn_number: string | null;
                    qb_purchase_order_list_id: string | null;
                  }
                | undefined;
              const refNumber = poRow?.qb_purchase_order_txn_number;
              if (refNumber) {
                try {
                  const fresh = await lookupPoByRefNumber(refNumber);
                  if (fresh) {
                    await knex.raw(
                      `UPDATE purchase_order
                          SET qb_purchase_order_list_id = ?,
                              qb_edit_sequence = ?,
                              qb_synced_at = NOW(),
                              updated_at = NOW()
                        WHERE id = ?`,
                      [fresh.txnId, fresh.editSequence, row.purchase_order_id]
                    );
                    const recoveredPl = {
                      ...pl,
                      is_query: false,
                      edit_sequence: fresh.editSequence,
                      txn_id: fresh.txnId,
                      _query_attempts: 0,
                      _refnumber_recovery_attempts: refRecoveryAttempts,
                    };
                    await knex.raw(
                      `UPDATE qb_purchase_order_pipeline
                          SET status = 'waiting',
                              qb_operation_id = NULL,
                              payload = ?,
                              last_error = NULL,
                              next_retry_at = NULL,
                              updated_at = NOW()
                        WHERE id = ?`,
                      [JSON.stringify(recoveredPl), row.id]
                    );
                    submitted++;
                    logger.warn(
                      `${TAG} row ${row.id}: TxnID query failed, RefNumber=${refNumber} fallback found PO → recovered TxnID=${fresh.txnId} EditSeq=${fresh.editSequence}`
                    );
                    continue;
                  }
                  logger.warn(
                    `${TAG} row ${row.id}: RefNumber=${refNumber} fallback also returned no PO`
                  );
                } catch (lookupErr) {
                  logger.warn(
                    `${TAG} row ${row.id}: RefNumber fallback threw: ${
                      lookupErr instanceof Error
                        ? lookupErr.message
                        : String(lookupErr)
                    }`
                  );
                }
              }
            }

            const reason = `PO not found in QB (TxnID: ${String(pl.txn_id ?? 'unknown')}) — may have been deleted`;
            logger.warn(`${TAG} row ${row.id}: ${reason}`);
            await knex.raw(
              `UPDATE qb_purchase_order_pipeline
                  SET status = 'error',
                      last_error = ?,
                      next_retry_at = NOW() + INTERVAL '${FIRST_ERROR_BACKOFF_MIN} minutes',
                      updated_at = NOW()
                WHERE id = ?`,
              [reason, row.id]
            );
            toError++;
          } else {
            // PO exists in QB but EditSequence missing from response — re-query to get it
            const requeuePl = { ...pl, is_query: true, edit_sequence: undefined };
            await knex.raw(
              `UPDATE qb_purchase_order_pipeline
                  SET status = 'waiting',
                      qb_operation_id = NULL,
                      payload = ?,
                      updated_at = NOW()
                WHERE id = ?`,
              [JSON.stringify(requeuePl), row.id]
            );
            submitted++;
            logger.info(
              `${TAG} row ${row.id}: PO found in QB but no EditSequence — re-queuing query`
            );
          }
        } else {
          // If we just ran line recovery, rebuild the lines array from DB so
          // the next Mod uses the freshly-mapped qb_txn_line_id values. Without
          // this, modPl.lines would still carry the stale IDs from the original
          // payload and the Mod would fail again with the same 3120 error.
          let refreshedLines = pl.lines as Array<Record<string, unknown>> | undefined;
          if (pl._needs_line_recovery) {
            const dbLines = await knex
              .raw(
                `SELECT id, qb_txn_line_id, qb_item_list_id_snapshot, sku_snapshot,
                        description_snapshot, qty_ordered, unit_cost_cents
                   FROM purchase_order_line
                  WHERE purchase_order_id = ?
                  ORDER BY line_order ASC, created_at ASC`,
                [row.purchase_order_id]
              )
              .then((r: any) => r.rows ?? []);
            refreshedLines = orderPurchaseOrderModLines(dbLines).map(
              (l: any) => ({
                line_id: l.id,
                qb_txn_line_id: l.qb_txn_line_id,
                qb_item_list_id: l.qb_item_list_id_snapshot,
                sku: l.sku_snapshot,
                description: l.description_snapshot,
                qty_ordered: l.qty_ordered,
                unit_cost_cents: l.unit_cost_cents,
              })
            );
          }
          const modPl = {
            ...pl,
            is_query: false,
            edit_sequence: editSequence,
            ...(refreshedLines ? { lines: refreshedLines } : {}),
            _needs_line_recovery: undefined,
          };
          await knex.raw(
            `UPDATE qb_purchase_order_pipeline
                SET status = 'waiting',
                    qb_operation_id = NULL,
                    payload = ?,
                    qb_list_id = NULL,
                    qb_txn_number = NULL,
                    synced_at = NULL,
                    updated_at = NOW()
              WHERE id = ?`,
            [JSON.stringify(modPl), row.id]
          );
          logger.info(
            `${TAG} row ${row.id}: got EditSequence ${editSequence} from QB, reset to ${pl.is_void ? "void" : "mod"}${pl._needs_line_recovery ? " (lines refreshed from DB)" : ""}`
          );
          submitted++; // count as progress
        }
        continue;
      }

      // VOID-BEFORE-CREATE RACE GUARD (delta v2).
      //
      // El route de void (`admin/purchase-orders/[id]/void`) sólo encola el
      // cierre en QB si el PO ya tiene `qb_purchase_order_list_id` — y ese ID
      // recién existe DESPUÉS de que QuickBooks confirmó la creación. Voidear
      // mientras el PO viaja (ventana medida: ~15 min) hacía que ese bloque se
      // salteara mudo: el PO quedaba voided en Medusa y abierto en QB para
      // siempre. Misma clase de bug que la POS Invoice 21246.
      //
      // El confirm es el primer instante en que se conoce el ListID, así que es
      // el punto de reintento correcto. Acá NO se puede encolar una fila nueva
      // como en el pipeline de ventas: `qb_purchase_order_pipeline` tiene un
      // unique index sobre purchase_order_id (UNA fila por PO), así que se
      // RE-ARMA la misma fila con el payload de void — el mismo patrón
      // UPDATE-in-place que ya usa el route.
      const [voidedPo] = await knex.raw(
        `SELECT id, number, status, qb_edit_sequence,
                vendor_qb_list_id_snapshot, vendor_name_snapshot
           FROM purchase_order
          WHERE id = ? AND status = 'voided' AND deleted_at IS NULL
          LIMIT 1`,
        [row.purchase_order_id]
      ).then((r: { rows: any[] }) => r.rows);

      if (voidedPo && !pl.is_void) {
        const voidPayload = {
          is_void: true,
          txn_id: txnId,
          // EditSequence fresco del propio confirm: le ahorra al dispatcher la
          // vuelta de query-antes-de-void.
          edit_sequence: editSequence ?? voidedPo.qb_edit_sequence ?? null,
          po_id: voidedPo.id,
          po_number: voidedPo.number,
          vendor_qb_list_id: voidedPo.vendor_qb_list_id_snapshot,
          vendor_name: voidedPo.vendor_name_snapshot,
        };
        await knex.raw(
          `UPDATE qb_purchase_order_pipeline
              SET status          = 'waiting',
                  qb_list_id      = ?,
                  qb_txn_number   = COALESCE(?, qb_txn_number),
                  qb_operation_id = NULL,
                  payload         = ?,
                  retries         = 0,
                  last_error      = NULL,
                  next_retry_at   = NULL,
                  synced_at       = NULL,
                  updated_at      = NOW()
            WHERE id = ?`,
          [txnId, refNumber, JSON.stringify(voidPayload), row.id]
        );
        resolved++;
        logger.warn(
          `${TAG} ⚠️ PO ${voidedPo.number} fue voideado antes de que su create confirmara — ` +
            `fila re-armada como void con TxnID=${txnId} (si no, quedaba abierto en QB)`
        );
        continue;
      }

      // Normal add/mod completion — mark synced
      await knex.raw(
        `UPDATE qb_purchase_order_pipeline
            SET status = 'synced',
                qb_list_id = ?,
                qb_txn_number = COALESCE(?, qb_txn_number),
                last_error = NULL,
                next_retry_at = NULL,
                synced_at = NOW(),
                updated_at = NOW()
          WHERE id = ?`,
        [txnId, refNumber, row.id]
      );

      resolved++;
      logger.info(
        `${TAG} PO ${row.purchase_order_id} synced → QB TxnID=${txnId}`
      );
    } catch (err: any) {
      logger.warn(`${TAG} poll failed for row ${row.id}: ${err.message}`);
    }
  }

  // ── Phase C: Retry error rows ─────────────────────────────────────────────
  const errorRows: any[] = await knex
    .raw(
      `SELECT id, purchase_order_id, payload, retries, last_error
       FROM qb_purchase_order_pipeline
      WHERE status = 'error'
        AND (next_retry_at IS NULL OR next_retry_at <= NOW())
        AND NOT (
          COALESCE(payload->>'is_mod', 'false') = 'true'
          AND (
            order_pipeline_id IS NOT NULL
            OR COALESCE(payload->>'delegated_to_consolidator', 'false') = 'true'
          )
        )
        AND deleted_at IS NULL
      LIMIT ?`,
      [MAX_ROWS_PER_TICK]
    )
    .then((r: any) => r.rows);

  if (errorRows.length > 0) {
    logger.info(`${TAG} phase C: retrying ${errorRows.length} error rows`);
  }

  for (const row of errorRows) {
    const newRetries = (row.retries ?? 0) + 1;
    const pl = row.payload as Record<string, unknown>;

    // EditSequence errors get a free re-query without burning a retry slot.
    const isEditSeqErrC = /editsequence|edit.?sequence|3[12]00|po not found in qb|may have been deleted/i.test(row.last_error ?? "");
    if ((pl.is_mod || pl.is_void) && !pl.is_query && isEditSeqErrC) {
      const freshPl = { ...pl, is_query: true, edit_sequence: undefined };
      await knex.raw(
        `UPDATE qb_purchase_order_pipeline
            SET status = 'waiting',
                qb_operation_id = NULL,
                payload = ?,
                next_retry_at = NULL,
                updated_at = NOW()
          WHERE id = ?`,
        [JSON.stringify(freshPl), row.id]
      );
      logger.warn(`${TAG} row ${row.id}: EditSequence error → re-queuing as query (free retry)`);
      retried++;
      continue;
    }

    const exhausted = newRetries >= MAX_RETRIES;

    if (exhausted) {
      // Zombie detector (Section 1.5.15 Phase 3a):
      //   When a Mod actually succeeded in QB but the bridge response parser
      //   couldn't extract the TxnID, the pipeline keeps retrying — but the
      //   parent purchase_order row gets `qb_synced_at` advanced on every
      //   completed poll. If the parent looks recently synced AND the error
      //   class is "parser_failed" or "po_missing", treat the row as a
      //   bookkeeping ghost and promote it to `synced` instead of escalating
      //   to `failed_permanent`. (Incident PO-1015/PO-1016, 2026-05-01.)
      const cls = classifyQbError({ message: row.last_error });
      if (cls.class === "parser_failed" || cls.class === "po_missing") {
        const parent = await knex
          .raw(
            `SELECT qb_synced_at, qb_purchase_order_list_id
               FROM purchase_order
              WHERE id = ?
              LIMIT 1`,
            [row.purchase_order_id]
          )
          .then((r: any) => r.rows[0]);
        const syncedAtMs = parent?.qb_synced_at
          ? new Date(parent.qb_synced_at).getTime()
          : 0;
        const recentlySynced =
          syncedAtMs > 0 && Date.now() - syncedAtMs < 60 * 60 * 1000;
        if (recentlySynced && parent?.qb_purchase_order_list_id) {
          await knex.raw(
            `UPDATE qb_purchase_order_pipeline
                SET status = 'synced',
                    retries = ?,
                    qb_list_id = ?,
                    last_error = NULL,
                    next_retry_at = NULL,
                    synced_at = NOW(),
                    updated_at = NOW()
              WHERE id = ?`,
            [newRetries, parent.qb_purchase_order_list_id, row.id]
          );
          resolved++;
          logger.warn(
            `${TAG} row ${row.id}: ZOMBIE detected (parent synced ${Math.round(
              (Date.now() - syncedAtMs) / 1000
            )}s ago, error class=${cls.class}) — promoted to synced instead of failed_permanent`
          );
          continue;
        }
      }

      await knex.raw(
        `UPDATE qb_purchase_order_pipeline
            SET status = 'failed_permanent',
                retries = ?,
                updated_at = NOW()
          WHERE id = ?`,
        [newRetries, row.id]
      );
      permaFailed++;
      logger.error(
        `${TAG} row ${row.id} failed_permanent after ${MAX_RETRIES} retries: ${row.last_error}`
      );
      continue;
    }

    try {
      let operationId: string;
      if (pl.is_void && !pl.is_query) {
        operationId = pl.edit_sequence
          ? await submitVoidToBridge(pl)
          : await submitQueryToBridge({ ...pl, is_query: true });
      } else if (pl.is_query) {
        operationId = await submitQueryToBridge(pl);
      } else if (pl.is_mod) {
        operationId = await submitModToBridge(pl);
      } else {
        // Guard: skip re-create if PO already landed in QB on a previous attempt.
        // Same pattern as the sales pipeline (MOD-first / check txn_id before create).
        const existing = await knex
          .raw(
            `SELECT qb_purchase_order_list_id FROM purchase_order WHERE id = ? LIMIT 1`,
            [row.purchase_order_id]
          )
          .then((r: any) => r.rows[0]);
        if (existing?.qb_purchase_order_list_id) {
          await knex.raw(
            `UPDATE qb_purchase_order_pipeline
                SET status = 'synced', qb_list_id = ?, last_error = NULL,
                    next_retry_at = NULL, synced_at = NOW(), updated_at = NOW()
              WHERE id = ?`,
            [existing.qb_purchase_order_list_id, row.id]
          );
          resolved++;
          logger.info(
            `${TAG} row ${row.id}: PO already in QB on retry (${existing.qb_purchase_order_list_id}), skipped re-create`
          );
          continue;
        }
        operationId = await submitToBridge(pl);
      }
      await knex.raw(
        `UPDATE qb_purchase_order_pipeline
            SET status = 'submitted',
                qb_operation_id = ?,
                retries = ?,
                last_error = NULL,
                next_retry_at = NULL,
                updated_at = NOW()
          WHERE id = ?`,
        [operationId, newRetries, row.id]
      );
      retried++;
    } catch (err: any) {
      const delay = backoffMs(newRetries);
      await knex.raw(
        `UPDATE qb_purchase_order_pipeline
            SET retries = ?,
                last_error = ?,
                next_retry_at = NOW() + (? * INTERVAL '1 millisecond'),
                updated_at = NOW()
          WHERE id = ?`,
        [newRetries, err.message, delay, row.id]
      );
      logger.warn(
        `${TAG} retry ${newRetries}/${MAX_RETRIES} failed for row ${row.id}: ${err.message}`
      );
    }
  }

  if (submitted || resolved || toError || retried || permaFailed) {
    logger.info(
      `${TAG} tick: submitted=${submitted} resolved=${resolved} ` +
        `→error=${toError} retried=${retried} failed_permanent=${permaFailed}`
    );
  }
}

export const config = {
  name: "qb-purchase-order-poller",
  schedule: "*/1 * * * *",
};

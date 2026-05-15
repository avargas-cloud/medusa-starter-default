/**
 * src/jobs/qb-item-receipt-poller.ts
 *
 * Three-phase cron for syncing ItemReceipts to QuickBooks Desktop.
 * An ItemReceipt in QB increases stock AND creates an AP debit note.
 *
 * Phase A — Submit: status='waiting', qb_operation_id IS NULL
 *   → POST /api/item-receipts → store operationId.
 *
 * Phase B — Poll: status='waiting', qb_operation_id IS NOT NULL
 *   → GET /api/sync/status/:opId → if completed, extract TxnID,
 *     update receipt row (qb_item_receipt_list_id, qb_synced_at), mark synced.
 *
 * Phase C — Retry: status='error', next_retry_at <= now
 *   → re-submit, reset to waiting.
 *
 * Phase D — Submit delete: void_status='waiting', void_operation_id IS NULL
 *   → DELETE /api/item-receipts/:txnId (TxnDelRq, hard delete in QB) → store
 *     operationId.
 *
 * Phase E — Poll delete: void_status='waiting', void_operation_id IS NOT NULL
 *   → if completed, hard-delete the receipt row (CASCADE wipes lines +
 *     vendor_bill + pipeline row).
 *
 * Note: the schema column `void_status` is kept for backwards compat but
 * represents the delete lifecycle. ItemReceipts in QB Desktop don't support
 * a meaningful void (would leave a $0 voided record), so we always delete.
 */

import { MedusaContainer } from "@medusajs/framework/types";
import { pollBridgeStatus } from "../lib/quickbooks/bridge-fetch";
import {
  markStaleRowsAsFailed,
  STANDARD_STALE_CONFIG,
} from "../lib/quickbooks/stale-row-cleanup";

const bridgeUrl = (): string =>
  process.env.QB_BRIDGE_URL || "https://qb.eptbridge.com";
const apiKey = (): string => process.env.QB_API_KEY || "";
const MAX_ROWS_PER_TICK = 30;
const MAX_RETRIES = 5;
const RETRY_BACKOFF_MIN: readonly number[] = [2, 4, 10, 30, 60] as const;
const FIRST_ERROR_BACKOFF_MIN = 2;

const backoffMs = (retryNum: number): number =>
  (RETRY_BACKOFF_MIN[Math.min(retryNum, RETRY_BACKOFF_MIN.length - 1)] ??
    FIRST_ERROR_BACKOFF_MIN) * 60_000;

type BridgeStatus = {
  operation?: {
    status?: "queued" | "processing" | "completed" | "failed" | "expired";
    error?: string;
    txnId?: string;
    listId?: string;
    refNumber?: string;
    result?: unknown;
  };
};

const pollBridge = async (operationId: string): Promise<BridgeStatus> => {
  // 404 → synthetic "expired" status (centralized in bridge-fetch helper).
  // See bridge-fetch.ts for rationale (incident PO-1015/PO-1016, 2026-04-29).
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

const submitAddToBridge = async (
  payload: Record<string, unknown>
): Promise<string> => {
  const res = await fetch(`${bridgeUrl()}/api/item-receipts`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey(),
      "bypass-tunnel-reminder": "true",
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok)
    throw new Error(`Bridge HTTP ${res.status} — ${await res.text()}`);
  const json = (await res.json()) as { operationId?: string; error?: string };
  if (!json.operationId)
    throw new Error(json.error ?? "Bridge returned no operationId");
  return json.operationId;
};

const submitDeleteToBridge = async (txnId: string): Promise<string> => {
  // ItemReceipts only support hard delete in QB Desktop (TxnDelRq). Void
  // would leave a $0 voided record which is meaningless for inventory
  // receipts, so we never void — always delete.
  const res = await fetch(`${bridgeUrl()}/api/item-receipts/${txnId}`, {
    method: "DELETE",
    headers: {
      "x-api-key": apiKey(),
      "bypass-tunnel-reminder": "true",
    },
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
  // ItemReceiptMod — payload carries txn_id + edit_sequence + full final
  // line set (with qb_po_txn_line_id per line so the bridge re-emits
  // LinkToTxn and preserves PO ↔ Receipt linkage). Bridge endpoint added
  // in chunk 2.
  const res = await fetch(`${bridgeUrl()}/api/item-receipts/mod`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey(),
      "bypass-tunnel-reminder": "true",
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok)
    throw new Error(`Bridge HTTP ${res.status} — ${await res.text()}`);
  const json = (await res.json()) as { operationId?: string; error?: string };
  if (!json.operationId)
    throw new Error(json.error ?? "Bridge returned no operationId");
  return json.operationId;
};

// QB Desktop error code 3175 = stale EditSequence. Detected so chunk 4 can
// trigger an automatic refresh; for now we just tag the row's last_error so
// the admin UI can show a specific badge instead of a generic "QB error".
const isEditSeqMismatch = (errMsg: string | null | undefined): boolean => {
  if (!errMsg) return false;
  return (
    errMsg.includes("3175") ||
    /edit\s*seq/i.test(errMsg) ||
    /editsequence/i.test(errMsg)
  );
};

const extractTxnId = (data: BridgeStatus): string | null => {
  const op = data.operation;
  if (!op) return null;
  if (op.txnId) return op.txnId;
  if (op.listId) return op.listId;
  const msgs =
    (op.result as any)?.QBXML?.QBXMLMsgsRs ??
    (op.result as any)?.QBXMLMsgsRs ??
    {};
  return msgs?.ItemReceiptAddRs?.ItemReceiptRet?.TxnID ?? null;
};

const extractRefNumber = (data: BridgeStatus): string | null => {
  const op = data.operation;
  if (op?.refNumber) return op.refNumber;
  const msgs =
    (op?.result as any)?.QBXML?.QBXMLMsgsRs ??
    (op?.result as any)?.QBXMLMsgsRs ??
    {};
  return msgs?.ItemReceiptAddRs?.ItemReceiptRet?.RefNumber ?? null;
};

// EditSequence is required to build ItemReceiptModRq later. Bridge is expected
// to surface it on the op (top-level) or inside the QBXML response. Until the
// bridge is updated in chunk 2, this returns null and that's fine — chunk 4
// adds an EditSequence query fallback for receipts without one cached.
const extractEditSequence = (data: BridgeStatus): string | null => {
  const op = data.operation;
  if ((op as any)?.editSequence) return (op as any).editSequence as string;
  const msgs =
    (op?.result as any)?.QBXML?.QBXMLMsgsRs ??
    (op?.result as any)?.QBXMLMsgsRs ??
    {};
  return (
    msgs?.ItemReceiptAddRs?.ItemReceiptRet?.EditSequence ??
    msgs?.ItemReceiptModRs?.ItemReceiptRet?.EditSequence ??
    null
  );
};

export default async function qbItemReceiptPoller(container: MedusaContainer) {
  const logger = container.resolve("logger") as any;
  const knex = (container as any).resolve("__pg_connection__");

  const TAG = "[qb-ir-poller]";

  // Safety net: demote rows stuck in waiting/submitted past their thresholds.
  await markStaleRowsAsFailed(
    knex,
    "qb_item_receipt_pipeline",
    STANDARD_STALE_CONFIG,
    { warn: (m) => logger.warn?.(`${TAG} ${m}`) }
  );

  let submitted = 0;
  let resolved = 0;
  let toError = 0;
  let retried = 0;
  let permaFailed = 0;
  let voidSubmitted = 0;
  let voidResolved = 0;
  let modSubmitted = 0;
  let modResolved = 0;
  let modToError = 0;
  let modRetried = 0;
  let modPermaFailed = 0;

  // ── Phase A: Submit unsubmitted add rows ─────────────────────────────────
  const unsubmitted: any[] = await knex
    .raw(
      `SELECT id, purchase_order_receipt_id, purchase_order_id, payload
       FROM qb_item_receipt_pipeline
      WHERE status = 'waiting'
        AND qb_operation_id IS NULL
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
      const operationId = await submitAddToBridge(
        row.payload as Record<string, unknown>
      );
      await knex.raw(
        `UPDATE qb_item_receipt_pipeline
            SET qb_operation_id = ?, updated_at = NOW()
          WHERE id = ?`,
        [operationId, row.id]
      );
      submitted++;
    } catch (err: any) {
      await knex.raw(
        `UPDATE qb_item_receipt_pipeline
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

  // ── Phase B: Poll submitted add rows ─────────────────────────────────────
  const polling: any[] = await knex
    .raw(
      `SELECT id, purchase_order_receipt_id, purchase_order_id, qb_operation_id
       FROM qb_item_receipt_pipeline
      WHERE status = 'waiting'
        AND qb_operation_id IS NOT NULL
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
      const opStatus = data.operation?.status;

      if (!opStatus || opStatus === "queued" || opStatus === "processing")
        continue;

      if (opStatus === "expired") {
        await knex.raw(
          `UPDATE qb_item_receipt_pipeline
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
        await knex.raw(
          `UPDATE qb_item_receipt_pipeline
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

      const txnId = extractTxnId(data);
      if (!txnId) {
        // Race-condition guard: bridge sometimes flips to status='completed'
        // momentarily before its result/error fields are populated. If we
        // see "completed" with neither a txnId nor an error message, keep
        // polling on the next tick instead of marking the row failed.
        if (!data.operation?.error) {
          logger.info(
            `${TAG} row ${row.id}: bridge status='${opStatus}' but no txnId/error yet — polling again next tick`
          );
          continue;
        }
        await knex.raw(
          `UPDATE qb_item_receipt_pipeline
              SET status = 'error',
                  last_error = ?,
                  next_retry_at = NOW() + INTERVAL '${FIRST_ERROR_BACKOFF_MIN} minutes',
                  updated_at = NOW()
            WHERE id = ?`,
          [
            `Completed but no TxnID in response: ${data.operation.error}`,
            row.id,
          ]
        );
        toError++;
        continue;
      }

      const refNumber = extractRefNumber(data);
      const editSequence = extractEditSequence(data);

      // Mark pipeline row synced
      await knex.raw(
        `UPDATE qb_item_receipt_pipeline
            SET status = 'synced',
                qb_list_id = ?,
                qb_txn_number = COALESCE(?, qb_txn_number),
                synced_at = NOW(),
                updated_at = NOW()
          WHERE id = ?`,
        [txnId, refNumber, row.id]
      );

      // Back-fill QB data on the receipt header. qb_edit_sequence uses
      // COALESCE so chunk-1 deployments don't clobber a previously cached
      // value on retry if the bridge hasn't started returning EditSequence
      // yet (chunk 2 work).
      await knex.raw(
        `UPDATE purchase_order_receipt
            SET qb_item_receipt_list_id = ?,
                qb_item_receipt_txn_number = COALESCE(?, qb_item_receipt_txn_number),
                qb_edit_sequence = COALESCE(?, qb_edit_sequence),
                qb_synced_at = NOW(),
                status = CASE WHEN status = 'pending' THEN 'applied' ELSE status END,
                updated_at = NOW()
          WHERE id = ?`,
        [txnId, refNumber, editSequence, row.purchase_order_receipt_id]
      );

      resolved++;
      logger.info(
        `${TAG} receipt ${row.purchase_order_receipt_id} synced → QB TxnID=${txnId}${refNumber ? ` Ref=${refNumber}` : ""}${editSequence ? ` EditSeq=${editSequence}` : ""}`
      );
    } catch (err: any) {
      logger.warn(`${TAG} poll failed for row ${row.id}: ${err.message}`);
    }
  }

  // ── Phase C: Retry error rows ─────────────────────────────────────────────
  const errorRows: any[] = await knex
    .raw(
      `SELECT id, purchase_order_receipt_id, payload, retries, last_error
       FROM qb_item_receipt_pipeline
      WHERE status = 'error'
        AND (next_retry_at IS NULL OR next_retry_at <= NOW())
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
    const exhausted = newRetries >= MAX_RETRIES;

    if (exhausted) {
      await knex.raw(
        `UPDATE qb_item_receipt_pipeline
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
      const operationId = await submitAddToBridge(
        row.payload as Record<string, unknown>
      );
      await knex.raw(
        `UPDATE qb_item_receipt_pipeline
            SET status = 'waiting',
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
        `UPDATE qb_item_receipt_pipeline
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

  // ── Phase D: Submit pending delete rows ───────────────────────────────────
  // ItemReceipts only support hard delete (TxnDel). The pipeline column is
  // historically named void_status but represents the delete lifecycle.
  const deletePending: any[] = await knex
    .raw(
      `SELECT qbp.id,
              qbp.purchase_order_receipt_id,
              qbp.qb_list_id
         FROM qb_item_receipt_pipeline qbp
        WHERE qbp.void_status = 'waiting'
          AND qbp.void_operation_id IS NULL
          AND qbp.qb_list_id IS NOT NULL
          AND qbp.deleted_at IS NULL
        LIMIT ?`,
      [MAX_ROWS_PER_TICK]
    )
    .then((r: any) => r.rows);

  if (deletePending.length > 0) {
    logger.info(
      `${TAG} phase D: submitting ${deletePending.length} delete rows`
    );
  }

  for (const row of deletePending) {
    try {
      const operationId = await submitDeleteToBridge(row.qb_list_id);
      await knex.raw(
        `UPDATE qb_item_receipt_pipeline
            SET void_operation_id = ?,
                void_status = 'processing',
                updated_at = NOW()
          WHERE id = ?`,
        [operationId, row.id]
      );
      voidSubmitted++;
    } catch (err: any) {
      await knex.raw(
        `UPDATE qb_item_receipt_pipeline
            SET void_status = 'error',
                void_last_error = ?,
                void_next_retry_at = NOW() + INTERVAL '${FIRST_ERROR_BACKOFF_MIN} minutes',
                updated_at = NOW()
          WHERE id = ?`,
        [err.message, row.id]
      );
      logger.error(
        `${TAG} void submit failed for row ${row.id}: ${err.message}`
      );
    }
  }

  // ── Phase E: Poll submitted void rows ─────────────────────────────────────
  const voidPolling: any[] = await knex
    .raw(
      `SELECT id, purchase_order_receipt_id, void_operation_id
       FROM qb_item_receipt_pipeline
      WHERE void_status = 'processing'
        AND void_operation_id IS NOT NULL
        AND deleted_at IS NULL
      LIMIT ?`,
      [MAX_ROWS_PER_TICK]
    )
    .then((r: any) => r.rows);

  for (const row of voidPolling) {
    try {
      const data = await pollBridge(row.void_operation_id);
      const opStatus = data.operation?.status;

      if (!opStatus || opStatus === "queued" || opStatus === "processing")
        continue;

      if (opStatus === "expired") {
        await knex.raw(
          `UPDATE qb_item_receipt_pipeline
           SET void_status = 'error',
               void_last_error = ?,
               void_operation_id = NULL,
               void_next_retry_at = NOW() + INTERVAL '2 minutes',
               updated_at = NOW()
           WHERE id = ?`,
          [data.operation?.error ?? "Bridge operation expired", row.id]
        );
        continue;
      }

      if (opStatus === "failed") {
        await knex.raw(
          `UPDATE qb_item_receipt_pipeline
              SET void_status = 'error',
                  void_last_error = ?,
                  void_next_retry_at = NOW() + INTERVAL '${FIRST_ERROR_BACKOFF_MIN} minutes',
                  updated_at = NOW()
            WHERE id = ?`,
          [data.operation?.error ?? "Bridge void failed", row.id]
        );
        continue;
      }

      // Delete completed in QB. Mark the pipeline row as voided so the
      // create + delete history stays visible in the QB Pipeline UI. The
      // receipt itself remains tombstoned (status='deleted') and is already
      // filtered out of receipt list queries.
      await knex.raw(
        `UPDATE qb_item_receipt_pipeline
            SET void_status = 'voided',
                void_synced_at = NOW(),
                void_last_error = NULL,
                void_next_retry_at = NULL,
                updated_at = NOW()
          WHERE id = ?`,
        [row.id]
      );
      logger.info(
        `${TAG} receipt ${row.purchase_order_receipt_id} delete confirmed in QB; pipeline row ${row.id} marked voided (audit trail preserved)`
      );

      voidResolved++;
    } catch (err: any) {
      logger.warn(`${TAG} void poll failed for row ${row.id}: ${err.message}`);
    }
  }

  // ── Phase F: Submit waiting MOD rows ─────────────────────────────────────
  // mod_status='waiting' AND mod_operation_id IS NULL means the row was just
  // enqueued by the update workflow and hasn't been handed to the bridge yet.
  const modPending: any[] = await knex
    .raw(
      `SELECT id, purchase_order_receipt_id, mod_payload, mod_retries
         FROM qb_item_receipt_pipeline
        WHERE mod_status = 'waiting'
          AND mod_operation_id IS NULL
          AND mod_payload IS NOT NULL
          AND (mod_next_retry_at IS NULL OR mod_next_retry_at <= NOW())
          AND deleted_at IS NULL
        LIMIT ?`,
      [MAX_ROWS_PER_TICK]
    )
    .then((r: any) => r.rows);

  if (modPending.length > 0) {
    logger.info(`${TAG} phase F: submitting ${modPending.length} mod rows`);
  }

  for (const row of modPending) {
    try {
      const operationId = await submitModToBridge(
        row.mod_payload as Record<string, unknown>
      );
      await knex.raw(
        `UPDATE qb_item_receipt_pipeline
            SET mod_status        = 'submitted',
                mod_operation_id  = ?,
                mod_last_error    = NULL,
                mod_next_retry_at = NULL,
                updated_at        = NOW()
          WHERE id = ?`,
        [operationId, row.id]
      );
      modSubmitted++;
    } catch (err: any) {
      await knex.raw(
        `UPDATE qb_item_receipt_pipeline
            SET mod_status        = 'error',
                mod_last_error    = ?,
                mod_next_retry_at = NOW() + INTERVAL '${FIRST_ERROR_BACKOFF_MIN} minutes',
                updated_at        = NOW()
          WHERE id = ?`,
        [err.message, row.id]
      );
      modToError++;
      logger.error(
        `${TAG} mod submit failed for row ${row.id}: ${err.message}`
      );
    }
  }

  // ── Phase G: Poll submitted MOD rows ─────────────────────────────────────
  const modPolling: any[] = await knex
    .raw(
      `SELECT id, purchase_order_receipt_id, mod_operation_id
         FROM qb_item_receipt_pipeline
        WHERE mod_status = 'submitted'
          AND mod_operation_id IS NOT NULL
          AND deleted_at IS NULL
        LIMIT ?`,
      [MAX_ROWS_PER_TICK]
    )
    .then((r: any) => r.rows);

  for (const row of modPolling) {
    try {
      const data = await pollBridge(row.mod_operation_id);
      const opStatus = data.operation?.status;

      if (!opStatus || opStatus === "queued" || opStatus === "processing")
        continue;

      if (opStatus === "expired") {
        await knex.raw(
          `UPDATE qb_item_receipt_pipeline
              SET mod_status        = 'error',
                  mod_last_error    = ?,
                  mod_operation_id  = NULL,
                  mod_next_retry_at = NOW() + INTERVAL '2 minutes',
                  updated_at        = NOW()
            WHERE id = ?`,
          [data.operation?.error ?? "Bridge mod operation expired", row.id]
        );
        modToError++;
        continue;
      }

      if (opStatus === "failed") {
        const errMsg = data.operation?.error ?? "Bridge mod failed";
        const tagged = isEditSeqMismatch(errMsg)
          ? `[EditSeqMismatch] ${errMsg}`
          : errMsg;
        await knex.raw(
          `UPDATE qb_item_receipt_pipeline
              SET mod_status        = 'error',
                  mod_last_error    = ?,
                  mod_next_retry_at = NOW() + INTERVAL '${FIRST_ERROR_BACKOFF_MIN} minutes',
                  updated_at        = NOW()
            WHERE id = ?`,
          [tagged, row.id]
        );
        modToError++;
        if (isEditSeqMismatch(errMsg)) {
          logger.warn(
            `${TAG} mod row ${row.id} hit EditSeqMismatch — will retry; full recovery (re-query EditSequence) lands in chunk 4`
          );
        }
        continue;
      }

      // Completed. Capture the new EditSequence for the next Mod and stamp
      // the receipt synced. mod_payload is freed to keep the JSONB column
      // lean (we don't need the frozen snapshot once the op succeeded).
      const newEditSequence = extractEditSequence(data);

      await knex.raw(
        `UPDATE qb_item_receipt_pipeline
            SET mod_status        = 'completed',
                mod_synced_at     = NOW(),
                mod_payload       = NULL,
                mod_last_error    = NULL,
                mod_next_retry_at = NULL,
                updated_at        = NOW()
          WHERE id = ?`,
        [row.id]
      );

      if (newEditSequence) {
        await knex.raw(
          `UPDATE purchase_order_receipt
              SET qb_edit_sequence = ?,
                  updated_at       = NOW()
            WHERE id = ?`,
          [newEditSequence, row.purchase_order_receipt_id]
        );
      }

      modResolved++;
      logger.info(
        `${TAG} receipt ${row.purchase_order_receipt_id} mod confirmed in QB${newEditSequence ? ` (new EditSeq=${newEditSequence})` : ""}`
      );
    } catch (err: any) {
      logger.warn(`${TAG} mod poll failed for row ${row.id}: ${err.message}`);
    }
  }

  // ── Phase H: Retry MOD error rows ────────────────────────────────────────
  const modErrorRows: any[] = await knex
    .raw(
      `SELECT id, purchase_order_receipt_id, mod_payload, mod_retries,
              mod_last_error
         FROM qb_item_receipt_pipeline
        WHERE mod_status = 'error'
          AND mod_payload IS NOT NULL
          AND mod_next_retry_at <= NOW()
          AND deleted_at IS NULL
        LIMIT ?`,
      [MAX_ROWS_PER_TICK]
    )
    .then((r: any) => r.rows);

  for (const row of modErrorRows) {
    const newRetries = (row.mod_retries ?? 0) + 1;
    const exhausted = newRetries >= MAX_RETRIES;

    if (exhausted) {
      await knex.raw(
        `UPDATE qb_item_receipt_pipeline
            SET mod_status        = 'failed_permanent',
                mod_retries       = ?,
                mod_next_retry_at = NULL,
                updated_at        = NOW()
          WHERE id = ?`,
        [newRetries, row.id]
      );
      modPermaFailed++;
      logger.error(
        `${TAG} mod row ${row.id} failed_permanent after ${MAX_RETRIES} retries: ${row.mod_last_error}`
      );
      continue;
    }

    try {
      const operationId = await submitModToBridge(
        row.mod_payload as Record<string, unknown>
      );
      await knex.raw(
        `UPDATE qb_item_receipt_pipeline
            SET mod_status        = 'submitted',
                mod_operation_id  = ?,
                mod_retries       = ?,
                mod_last_error    = NULL,
                mod_next_retry_at = NULL,
                updated_at        = NOW()
          WHERE id = ?`,
        [operationId, newRetries, row.id]
      );
      modRetried++;
    } catch (err: any) {
      const delay = backoffMs(newRetries);
      await knex.raw(
        `UPDATE qb_item_receipt_pipeline
            SET mod_retries       = ?,
                mod_last_error    = ?,
                mod_next_retry_at = NOW() + (? * INTERVAL '1 millisecond'),
                updated_at        = NOW()
          WHERE id = ?`,
        [newRetries, err.message, delay, row.id]
      );
      logger.warn(
        `${TAG} mod retry ${newRetries}/${MAX_RETRIES} failed for row ${row.id}: ${err.message}`
      );
    }
  }

  if (
    submitted ||
    resolved ||
    toError ||
    retried ||
    permaFailed ||
    voidSubmitted ||
    voidResolved ||
    modSubmitted ||
    modResolved ||
    modToError ||
    modRetried ||
    modPermaFailed
  ) {
    logger.info(
      `${TAG} tick: submitted=${submitted} resolved=${resolved} →error=${toError} ` +
        `retried=${retried} failed_permanent=${permaFailed} ` +
        `void_submitted=${voidSubmitted} void_resolved=${voidResolved} ` +
        `mod_submitted=${modSubmitted} mod_resolved=${modResolved} ` +
        `mod_→error=${modToError} mod_retried=${modRetried} ` +
        `mod_failed_permanent=${modPermaFailed}`
    );
  }
}

export const config = {
  name: "qb-item-receipt-poller",
  schedule: "*/1 * * * *",
};

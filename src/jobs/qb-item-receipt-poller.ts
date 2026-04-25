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
 * Phase D — Submit void: void_status='waiting', void_operation_id IS NULL
 *   → DELETE /api/item-receipts/:txnId → store void operationId.
 *
 * Phase E — Poll void: void_status='waiting', void_operation_id IS NOT NULL
 *   → if completed, mark void_status='synced'; update receipt status='voided'.
 */

import { MedusaContainer } from "@medusajs/framework/types";

const bridgeUrl = (): string =>
  process.env.QB_BRIDGE_URL || "https://qb.eptbridge.com";
const apiKey = (): string => process.env.QB_API_KEY || "";
const MAX_ROWS_PER_TICK = 30;
const MAX_RETRIES = 5;
const RETRY_BACKOFF_MIN: readonly number[] = [2, 4, 10, 30, 60] as const;
const FIRST_ERROR_BACKOFF_MIN = 2;

const backoffMs = (retryNum: number): number =>
  (RETRY_BACKOFF_MIN[Math.min(retryNum, RETRY_BACKOFF_MIN.length - 1)] ??
    FIRST_ERROR_BACKOFF_MIN) *
  60_000;

type BridgeStatus = {
  operation?: {
    status?: "queued" | "processing" | "completed" | "failed";
    error?: string;
    txnId?: string;
    listId?: string;
    result?: unknown;
  };
};

const pollBridge = async (operationId: string): Promise<BridgeStatus> => {
  const res = await fetch(
    `${bridgeUrl()}/api/sync/status/${operationId}`,
    {
      headers: {
        "x-api-key": apiKey(),
        "bypass-tunnel-reminder": "true",
      },
    }
  );
  if (!res.ok) throw new Error(`Bridge HTTP ${res.status}`);
  return (await res.json()) as BridgeStatus;
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
  if (!res.ok) throw new Error(`Bridge HTTP ${res.status} — ${await res.text()}`);
  const json = (await res.json()) as { operationId?: string; error?: string };
  if (!json.operationId) throw new Error(json.error ?? "Bridge returned no operationId");
  return json.operationId;
};

const submitVoidToBridge = async (txnId: string): Promise<string> => {
  const res = await fetch(`${bridgeUrl()}/api/item-receipts/${txnId}`, {
    method: "DELETE",
    headers: {
      "x-api-key": apiKey(),
      "bypass-tunnel-reminder": "true",
    },
  });
  if (!res.ok) throw new Error(`Bridge HTTP ${res.status} — ${await res.text()}`);
  const json = (await res.json()) as { operationId?: string; error?: string };
  if (!json.operationId) throw new Error(json.error ?? "Bridge returned no operationId");
  return json.operationId;
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

export default async function qbItemReceiptPoller(container: MedusaContainer) {
  const logger = container.resolve("logger") as any;
  const knex = (container as any).resolve("__pg_connection__");

  const TAG = "[qb-ir-poller]";

  let submitted = 0;
  let resolved = 0;
  let toError = 0;
  let retried = 0;
  let permaFailed = 0;
  let voidSubmitted = 0;
  let voidResolved = 0;

  // ── Phase A: Submit unsubmitted add rows ─────────────────────────────────
  const unsubmitted: any[] = await knex.raw(
    `SELECT id, purchase_order_receipt_id, purchase_order_id, payload
       FROM qb_item_receipt_pipeline
      WHERE status = 'waiting'
        AND qb_operation_id IS NULL
        AND deleted_at IS NULL
      LIMIT ?`,
    [MAX_ROWS_PER_TICK]
  ).then((r: any) => r.rows);

  if (unsubmitted.length > 0) {
    logger.info(`${TAG} phase A: submitting ${unsubmitted.length} unsubmitted rows`);
  }

  for (const row of unsubmitted) {
    try {
      const operationId = await submitAddToBridge(row.payload as Record<string, unknown>);
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
  const polling: any[] = await knex.raw(
    `SELECT id, purchase_order_receipt_id, purchase_order_id, qb_operation_id
       FROM qb_item_receipt_pipeline
      WHERE status = 'waiting'
        AND qb_operation_id IS NOT NULL
        AND deleted_at IS NULL
      LIMIT ?`,
    [MAX_ROWS_PER_TICK]
  ).then((r: any) => r.rows);

  if (polling.length > 0) {
    logger.info(`${TAG} phase B: polling ${polling.length} submitted rows`);
  }

  for (const row of polling) {
    try {
      const data = await pollBridge(row.qb_operation_id);
      const opStatus = data.operation?.status;

      if (!opStatus || opStatus === "queued" || opStatus === "processing") continue;

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
        await knex.raw(
          `UPDATE qb_item_receipt_pipeline
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

      // Mark pipeline row synced
      await knex.raw(
        `UPDATE qb_item_receipt_pipeline
            SET status = 'synced',
                qb_list_id = ?,
                synced_at = NOW(),
                updated_at = NOW()
          WHERE id = ?`,
        [txnId, row.id]
      );

      // Back-fill QB data on the receipt header
      await knex.raw(
        `UPDATE purchase_order_receipt
            SET qb_item_receipt_list_id = ?,
                qb_synced_at = NOW(),
                status = CASE WHEN status = 'pending' THEN 'applied' ELSE status END,
                updated_at = NOW()
          WHERE id = ?`,
        [txnId, row.purchase_order_receipt_id]
      );

      resolved++;
      logger.info(
        `${TAG} receipt ${row.purchase_order_receipt_id} synced → QB TxnID=${txnId}`
      );
    } catch (err: any) {
      logger.warn(`${TAG} poll failed for row ${row.id}: ${err.message}`);
    }
  }

  // ── Phase C: Retry error rows ─────────────────────────────────────────────
  const errorRows: any[] = await knex.raw(
    `SELECT id, purchase_order_receipt_id, payload, retries, last_error
       FROM qb_item_receipt_pipeline
      WHERE status = 'error'
        AND (next_retry_at IS NULL OR next_retry_at <= NOW())
        AND deleted_at IS NULL
      LIMIT ?`,
    [MAX_ROWS_PER_TICK]
  ).then((r: any) => r.rows);

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
      const operationId = await submitAddToBridge(row.payload as Record<string, unknown>);
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
      logger.warn(`${TAG} retry ${newRetries}/${MAX_RETRIES} failed for row ${row.id}: ${err.message}`);
    }
  }

  // ── Phase D: Submit pending void rows ─────────────────────────────────────
  const voidPending: any[] = await knex.raw(
    `SELECT id, purchase_order_receipt_id, qb_list_id
       FROM qb_item_receipt_pipeline
      WHERE void_status = 'waiting'
        AND void_operation_id IS NULL
        AND qb_list_id IS NOT NULL
        AND deleted_at IS NULL
      LIMIT ?`,
    [MAX_ROWS_PER_TICK]
  ).then((r: any) => r.rows);

  if (voidPending.length > 0) {
    logger.info(`${TAG} phase D: submitting ${voidPending.length} void rows`);
  }

  for (const row of voidPending) {
    try {
      const operationId = await submitVoidToBridge(row.qb_list_id);
      await knex.raw(
        `UPDATE qb_item_receipt_pipeline
            SET void_operation_id = ?, updated_at = NOW()
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
      logger.error(`${TAG} void submit failed for row ${row.id}: ${err.message}`);
    }
  }

  // ── Phase E: Poll submitted void rows ─────────────────────────────────────
  const voidPolling: any[] = await knex.raw(
    `SELECT id, purchase_order_receipt_id, void_operation_id
       FROM qb_item_receipt_pipeline
      WHERE void_status = 'waiting'
        AND void_operation_id IS NOT NULL
        AND deleted_at IS NULL
      LIMIT ?`,
    [MAX_ROWS_PER_TICK]
  ).then((r: any) => r.rows);

  for (const row of voidPolling) {
    try {
      const data = await pollBridge(row.void_operation_id);
      const opStatus = data.operation?.status;

      if (!opStatus || opStatus === "queued" || opStatus === "processing") continue;

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

      // Void completed
      await knex.raw(
        `UPDATE qb_item_receipt_pipeline
            SET void_status = 'synced',
                void_synced_at = NOW(),
                updated_at = NOW()
          WHERE id = ?`,
        [row.id]
      );

      // Mark receipt as voided in QB sync state
      await knex.raw(
        `UPDATE purchase_order_receipt
            SET qb_item_receipt_list_id = NULL,
                qb_synced_at = NOW(),
                status = 'voided',
                updated_at = NOW()
          WHERE id = ?`,
        [row.purchase_order_receipt_id]
      );

      voidResolved++;
      logger.info(`${TAG} receipt ${row.purchase_order_receipt_id} voided in QB`);
    } catch (err: any) {
      logger.warn(`${TAG} void poll failed for row ${row.id}: ${err.message}`);
    }
  }

  if (
    submitted || resolved || toError || retried || permaFailed ||
    voidSubmitted || voidResolved
  ) {
    logger.info(
      `${TAG} tick: submitted=${submitted} resolved=${resolved} →error=${toError} ` +
        `retried=${retried} failed_permanent=${permaFailed} ` +
        `void_submitted=${voidSubmitted} void_resolved=${voidResolved}`
    );
  }
}

export const config = {
  name: "qb-item-receipt-poller",
  schedule: "*/1 * * * *",
};

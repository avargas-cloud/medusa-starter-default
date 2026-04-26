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
    status?: "queued" | "processing" | "completed" | "failed";
    error?: string;
    txnId?: string;
    listId?: string;
    result?: unknown;
  };
};

const pollBridge = async (operationId: string): Promise<BridgeStatus> => {
  const res = await fetch(`${bridgeUrl()}/api/sync/status/${operationId}`, {
    headers: {
      "x-api-key": apiKey(),
      "bypass-tunnel-reminder": "true",
    },
  });
  if (!res.ok) throw new Error(`Bridge HTTP ${res.status}`);
  return (await res.json()) as BridgeStatus;
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
  const res = await fetch(`${bridgeUrl()}/api/purchase-orders/void`, {
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

const submitModToBridge = async (
  payload: Record<string, unknown>
): Promise<string> => {
  const res = await fetch(`${bridgeUrl()}/api/purchase-orders/mod`, {
    method: "PUT",
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

const submitToBridge = async (
  payload: Record<string, unknown>
): Promise<string> => {
  const res = await fetch(`${bridgeUrl()}/api/purchase-orders`, {
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

const extractPoRet = (data: BridgeStatus): any => {
  const op = data.operation;
  if (!op) return null;
  const msgs =
    (op.result as any)?.QBXML?.QBXMLMsgsRs ??
    (op.result as any)?.QBXMLMsgsRs ??
    {};
  return (
    msgs?.PurchaseOrderAddRs?.PurchaseOrderRet ??
    msgs?.PurchaseOrderModRs?.PurchaseOrderRet ??
    msgs?.PurchaseOrderQueryRs?.PurchaseOrderRet ??
    null
  );
};

const extractTxnId = (data: BridgeStatus): string | null => {
  const op = data.operation;
  if (!op) return null;
  if (op.txnId) return op.txnId;
  if (op.listId) return op.listId;
  return extractPoRet(data)?.TxnID ?? null;
};

const extractRefNumber = (data: BridgeStatus): string | null =>
  extractPoRet(data)?.RefNumber ?? null;

const extractEditSequence = (data: BridgeStatus): string | null =>
  extractPoRet(data)?.EditSequence ?? null;

const extractTxnLineIds = (data: BridgeStatus): string[] => {
  const ret = extractPoRet(data);
  if (!ret) return [];
  const lineRets = ret.PurchaseOrderLineRet;
  if (!lineRets) return [];
  const arr = Array.isArray(lineRets) ? lineRets : [lineRets];
  return arr.map((l: any) => l.TxnLineID ?? "").filter(Boolean);
};

export default async function qbPurchaseOrderPoller(
  container: MedusaContainer
) {
  const logger = container.resolve("logger") as any;
  const knex = (container as any).resolve("__pg_connection__");

  const TAG = "[qb-po-poller]";

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
        operationId = await submitToBridge(pl);
      }

      await knex.raw(
        `UPDATE qb_purchase_order_pipeline
            SET qb_operation_id = ?, updated_at = NOW()
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

  // ── Phase B: Poll submitted waiting rows ─────────────────────────────────
  const polling: any[] = await knex
    .raw(
      `SELECT id, purchase_order_id, qb_operation_id, payload
       FROM qb_purchase_order_pipeline
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

      if (opStatus === "failed") {
        const errMsg = data.operation?.error ?? "Bridge returned failed";
        const pl = row.payload as Record<string, unknown>;

        // Stale/missing EditSequence (QB status 3100 or message text) → re-query QB, then retry mod
        const isEditSeqErr = /editsequence|edit.?sequence|3100/i.test(errMsg);
        if (pl.is_mod && isEditSeqErr) {
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
      // For query ops the TxnID is already known from the payload; don't require it from QB response
      const txnId =
        extractTxnId(data) ??
        (pl.is_query ? (pl.txn_id as string | null) : null);
      if (!txnId) {
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

      // Query-before-mod: reset this row to a pending mod with the fresh EditSequence
      if (pl.is_query && pl.is_mod) {
        if (!editSequence) {
          logger.warn(
            `${TAG} row ${row.id}: query completed but no EditSequence in response — marking error`
          );
          await knex.raw(
            `UPDATE qb_purchase_order_pipeline
                SET status = 'error',
                    last_error = 'QB query returned no EditSequence',
                    next_retry_at = NOW() + INTERVAL '${FIRST_ERROR_BACKOFF_MIN} minutes',
                    updated_at = NOW()
              WHERE id = ?`,
            [row.id]
          );
          toError++;
        } else {
          const modPl = { ...pl, is_query: false, edit_sequence: editSequence };
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
            `${TAG} row ${row.id}: got EditSequence ${editSequence} from QB, reset to mod`
          );
          submitted++; // count as progress
        }
        continue;
      }

      // Normal add/mod completion — mark synced
      await knex.raw(
        `UPDATE qb_purchase_order_pipeline
            SET status = 'synced',
                qb_list_id = ?,
                qb_txn_number = COALESCE(?, qb_txn_number),
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
      const pl = row.payload as Record<string, unknown>;
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
        operationId = await submitToBridge(pl);
      }
      await knex.raw(
        `UPDATE qb_purchase_order_pipeline
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

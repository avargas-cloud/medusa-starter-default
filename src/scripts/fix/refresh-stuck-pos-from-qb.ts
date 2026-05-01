/**
 * One-shot recovery for POs stuck in the QB pipeline due to a stale TxnID.
 *
 * What it does:
 *   1. For each (po_number, ref_number) pair: query QB via the existing
 *      bridge `direct-query` endpoint by RefNumber (the human-visible PO #)
 *      to fetch the CURRENT TxnID + EditSequence from QuickBooks Desktop.
 *   2. Update purchase_order with the fresh TxnID and EditSequence.
 *   3. Reset the active pipeline row: payload gets fresh values, status
 *      goes back to 'waiting', retries → 0, qb_operation_id cleared. The
 *      poller will re-submit a Modify with current data on the next tick.
 *
 * Why a script instead of the UI Retry button:
 *   The UI Retry resubmits the same payload, which contains the stale TxnID
 *   that caused the loop in the first place. We need to refresh from QB
 *   first, then retry.
 *
 * Usage:
 *   yarn medusa exec src/scripts/fix/refresh-stuck-pos-from-qb.ts
 */
import type { ExecArgs } from "@medusajs/framework/types";
import { bridgeFetch } from "../../lib/quickbooks/bridge-fetch";

interface PoRefresh {
  poNumber: string;
  refNumber: string;
}

const TARGETS: PoRefresh[] = [
  { poNumber: "PO-1015", refNumber: "174241" },
  { poNumber: "PO-1016", refNumber: "174226" },
];

const POLL_INTERVAL_MS = 2_000;
const MAX_POLL_ATTEMPTS = 60;

interface FreshPo {
  txnId: string;
  editSequence: string;
  refNumber: string;
}

async function lookupPoByRef(refNumber: string): Promise<FreshPo | null> {
  const qbxml = [
    `<?xml version="1.0" encoding="utf-8"?>`,
    `<?qbxml version="10.0"?>`,
    `<QBXML><QBXMLMsgsRq onError="stopOnError">`,
    `<PurchaseOrderQueryRq requestID="1">`,
    `<RefNumber>${refNumber}</RefNumber>`,
    `</PurchaseOrderQueryRq>`,
    `</QBXMLMsgsRq></QBXML>`,
  ].join("");

  const enqueueRes = await bridgeFetch<{
    operationId?: string;
    operation_id?: string;
  }>("/api/sync/direct-query", { method: "POST", body: { qbxml } });
  const operationId = enqueueRes?.operationId || enqueueRes?.operation_id;
  if (!operationId) throw new Error("Bridge did not return operationId");

  for (let attempt = 1; attempt <= MAX_POLL_ATTEMPTS; attempt++) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const statusRes = await bridgeFetch<{
      operation?: { status?: string; result?: unknown; error?: string };
    }>(`/api/sync/status/${operationId}`);
    const op = statusRes?.operation;
    if (!op) continue;
    if (op.status === "completed") {
      const result = op.result as Record<string, unknown>;
      const msgs: Record<string, unknown> =
        ((result as Record<string, unknown>)?.QBXML as Record<string, unknown>)
          ?.QBXMLMsgsRs as Record<string, unknown> ??
        ((result as Record<string, unknown>)?.QBXMLMsgsRs as Record<
          string,
          unknown
        >) ??
        result;
      const retRaw =
        (msgs as any)?.PurchaseOrderQueryRs?.PurchaseOrderRet ??
        (result as any)?.PurchaseOrderRet ??
        null;
      if (!retRaw) return null;
      const doc: Record<string, string> = Array.isArray(retRaw)
        ? retRaw[0]
        : retRaw;
      const txnId = doc?.TxnID || "";
      const editSequence = doc?.EditSequence || "";
      const refOut = doc?.RefNumber || refNumber;
      if (!txnId || !editSequence) return null;
      return { txnId, editSequence, refNumber: refOut };
    }
    if (op.status === "failed") {
      throw new Error(
        `Bridge direct-query failed: ${op.error || "Unknown error"}`
      );
    }
  }
  throw new Error("Bridge direct-query timed out");
}

export default async function refreshStuckPos({ container }: ExecArgs) {
  const knex = (container as any).resolve("__pg_connection__");
  const logger = container.resolve("logger") as any;

  for (const tgt of TARGETS) {
    logger.info(
      `\n=== Refreshing ${tgt.poNumber} (RefNumber=${tgt.refNumber}) from QB ===`
    );

    let fresh: FreshPo | null = null;
    try {
      fresh = await lookupPoByRef(tgt.refNumber);
    } catch (err: any) {
      logger.error(`  ❌ Bridge lookup error: ${err.message}`);
      continue;
    }
    if (!fresh) {
      logger.warn(
        `  ⚠️ PO RefNumber ${tgt.refNumber} NOT found in QB — skipping`
      );
      continue;
    }
    logger.info(
      `  ✅ Fresh from QB: TxnID=${fresh.txnId}, EditSeq=${fresh.editSequence}`
    );

    const { rows: poRows } = await knex.raw(
      `SELECT id, number,
              qb_purchase_order_list_id AS old_txn,
              qb_edit_sequence          AS old_edit
         FROM purchase_order
        WHERE number = ?`,
      [tgt.poNumber]
    );
    if (poRows.length === 0) {
      logger.warn(`  ⚠️ no purchase_order row with number=${tgt.poNumber}`);
      continue;
    }
    const po = poRows[0];
    logger.info(
      `  PO ${po.number} (${po.id}): old TxnID=${po.old_txn}, old EditSeq=${po.old_edit}`
    );

    await knex.raw(
      `UPDATE purchase_order
          SET qb_purchase_order_list_id    = ?,
              qb_purchase_order_txn_number = ?,
              qb_edit_sequence             = ?,
              qb_synced_at                 = NOW(),
              updated_at                   = NOW()
        WHERE id = ?`,
      [fresh.txnId, fresh.refNumber, fresh.editSequence, po.id]
    );

    const { rows: pipeRows } = await knex.raw(
      `SELECT id, payload
         FROM qb_purchase_order_pipeline
        WHERE purchase_order_id = ?
          AND deleted_at IS NULL
          AND status IN ('error','waiting','submitted','failed_permanent')
        ORDER BY created_at DESC
        LIMIT 1`,
      [po.id]
    );
    if (pipeRows.length === 0) {
      logger.warn(`    ⚠️ no active pipeline row found for ${po.number}`);
      continue;
    }
    const pipe = pipeRows[0];
    const oldPayload =
      typeof pipe.payload === "string"
        ? JSON.parse(pipe.payload)
        : pipe.payload;
    const newPayload = {
      ...oldPayload,
      txn_id: fresh.txnId,
      edit_sequence: fresh.editSequence,
      is_query: false,
    };

    await knex.raw(
      `UPDATE qb_purchase_order_pipeline
          SET payload         = ?,
              status          = 'waiting',
              qb_operation_id = NULL,
              retries         = 0,
              last_error      = COALESCE(last_error, '') || ' [refreshed from QB by RefNumber 2026-05-01]',
              next_retry_at   = NULL,
              updated_at      = NOW()
        WHERE id = ?`,
      [JSON.stringify(newPayload), pipe.id]
    );
    logger.info(
      `    ✅ pipeline ${pipe.id} reset — payload now has fresh TxnID + EditSeq`
    );
  }

  logger.info(`\nDone. PO poller will pick up the rows on its next tick.`);
}

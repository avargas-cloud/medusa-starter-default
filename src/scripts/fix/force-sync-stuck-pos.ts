/**
 * Force-mark stuck PO pipeline rows as `synced` after confirming QB state.
 *
 * Why this exists:
 *   The poller's response parser fails to extract TxnID from the bridge's
 *   PurchaseOrderMod response in some cases (the Mod actually succeeds in QB
 *   — EditSequence advances every cycle — but the pipeline row keeps
 *   re-querying because it can't tell). Manual unstick:
 *     1. RefNumber → query QB for current TxnID + EditSequence (truth)
 *     2. Update purchase_order with the truth
 *     3. Mark pipeline row `synced` so the loop ends
 *
 * Usage:
 *   yarn medusa exec src/scripts/fix/force-sync-stuck-pos.ts
 */
import type { ExecArgs } from "@medusajs/framework/types";
import { bridgeFetch } from "../../lib/quickbooks/bridge-fetch";

interface Target {
  poNumber: string;
  refNumber: string;
}

const TARGETS: Target[] = [
  { poNumber: "PO-1015", refNumber: "174241" },
  { poNumber: "PO-1016", refNumber: "174226" },
];

interface FreshPo {
  txnId: string;
  editSequence: string;
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

  const enq = await bridgeFetch<{
    operationId?: string;
    operation_id?: string;
  }>("/api/sync/direct-query", { method: "POST", body: { qbxml } });
  const opId = enq?.operationId || enq?.operation_id;
  if (!opId) throw new Error("no operationId");
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const st = await bridgeFetch<{
      operation?: { status?: string; result?: unknown; error?: string };
    }>(`/api/sync/status/${opId}`);
    const op = st?.operation;
    if (!op) continue;
    if (op.status === "completed") {
      const result = op.result as Record<string, unknown>;
      const msgs =
        ((result as any)?.QBXML?.QBXMLMsgsRs as Record<string, unknown>) ??
        ((result as any)?.QBXMLMsgsRs as Record<string, unknown>) ??
        result;
      const ret =
        (msgs as any)?.PurchaseOrderQueryRs?.PurchaseOrderRet ??
        (result as any)?.PurchaseOrderRet ??
        null;
      if (!ret) return null;
      const doc = (Array.isArray(ret) ? ret[0] : ret) as Record<string, string>;
      if (!doc.TxnID || !doc.EditSequence) return null;
      return { txnId: doc.TxnID, editSequence: doc.EditSequence };
    }
    if (op.status === "failed") {
      throw new Error(op.error || "bridge query failed");
    }
  }
  throw new Error("timeout");
}

export default async function forceSync({ container }: ExecArgs) {
  const knex = (container as any).resolve("__pg_connection__");
  const logger = container.resolve("logger") as any;

  for (const tgt of TARGETS) {
    logger.info(`\n=== ${tgt.poNumber} (RefNumber=${tgt.refNumber}) ===`);
    let fresh: FreshPo | null = null;
    try {
      fresh = await lookupPoByRef(tgt.refNumber);
    } catch (err: any) {
      logger.error(`  ❌ lookup error: ${err.message}`);
      continue;
    }
    if (!fresh) {
      logger.warn(`  ⚠️ not found in QB`);
      continue;
    }
    logger.info(`  ✅ QB truth: TxnID=${fresh.txnId}, EditSeq=${fresh.editSequence}`);

    const { rows: poRows } = await knex.raw(
      `SELECT id FROM purchase_order WHERE number = ?`,
      [tgt.poNumber]
    );
    if (poRows.length === 0) {
      logger.warn(`  ⚠️ no purchase_order with number=${tgt.poNumber}`);
      continue;
    }
    const poId = poRows[0].id;

    await knex.raw(
      `UPDATE purchase_order
          SET qb_purchase_order_list_id    = ?,
              qb_purchase_order_txn_number = ?,
              qb_edit_sequence             = ?,
              qb_synced_at                 = NOW(),
              updated_at                   = NOW()
        WHERE id = ?`,
      [fresh.txnId, tgt.refNumber, fresh.editSequence, poId]
    );

    const { rows: pipeRows } = await knex.raw(
      `SELECT id FROM qb_purchase_order_pipeline
        WHERE purchase_order_id = ?
          AND deleted_at IS NULL
          AND status IN ('error','waiting','submitted','failed_permanent')
        ORDER BY created_at DESC
        LIMIT 1`,
      [poId]
    );
    if (pipeRows.length === 0) {
      logger.warn(`  ⚠️ no active pipeline row for ${tgt.poNumber}`);
      continue;
    }

    await knex.raw(
      `UPDATE qb_purchase_order_pipeline
          SET status          = 'synced',
              qb_list_id      = ?,
              qb_txn_number   = ?,
              qb_operation_id = NULL,
              last_error      = NULL,
              next_retry_at   = NULL,
              synced_at       = NOW(),
              updated_at      = NOW()
        WHERE id = ?`,
      [fresh.txnId, tgt.refNumber, pipeRows[0].id]
    );

    logger.info(`  ✅ pipeline ${pipeRows[0].id} → synced (forced after confirming QB state)`);
  }

  logger.info(`\nDone.`);
}

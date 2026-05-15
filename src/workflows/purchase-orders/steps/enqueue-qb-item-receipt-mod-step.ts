/**
 * src/workflows/purchase-orders/steps/enqueue-qb-item-receipt-mod-step.ts
 *
 * Enqueues an ItemReceiptMod sync against QB Desktop for a receipt that has
 * already been synced (qb_item_receipt_list_id present).
 *
 * Unlike the Add path, the Mod payload is rehydrated FROM THE CURRENT DB
 * STATE — never a delta. The cron poller's ItemReceiptModRq replaces all
 * lines, so the payload contains the full final shape of the receipt, and
 * each line carries its qb_po_txn_line_id so the bridge can re-emit
 * <LinkToTxn> per line and preserve the PO ↔ Receipt linkage in QB.
 *
 * Guards (defensive — the PATCH route is expected to enforce these first):
 *   - pipeline row exists and status='synced'
 *   - void_status not active (NULL or 'completed')
 *   - mod_status not already pending (NULL, 'completed', or 'failed_permanent')
 *   - receipt has qb_item_receipt_list_id (TxnID)
 *
 * The frozen mod_payload is written to qb_item_receipt_pipeline.mod_payload
 * and mod_status flips to 'waiting'. The cron poller's Phase F picks it up
 * on the next tick.
 */

import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk";

export interface EnqueueQbItemReceiptModStepInput {
  receipt_id: string;
  // PATCH route decides: true if the receipt was already synced AND something
  // changed that QB needs to see (qty delta or vendor_bill_number). When
  // false, the step is a no-op so the update workflow can call it
  // unconditionally without polluting the pipeline.
  should_enqueue: boolean;
}

export interface EnqueueQbItemReceiptModStepOutput {
  pipeline_id: string | null;
  enqueued: boolean;
}

interface QbItemReceiptModPayloadLine {
  receipt_line_id: string;
  po_line_id: string;
  qb_item_list_id: string;
  qb_po_txn_line_id: string | null;
  sku: string;
  description: string;
  qty_received_now: number;
  unit_cost_cents: number;
}

interface QbItemReceiptModPayload {
  txn_id: string;
  edit_sequence: string | null;
  po_id: string;
  po_number: string;
  receipt_id: string;
  receipt_number: string;
  vendor_qb_list_id: string;
  vendor_name: string;
  qb_po_list_id: string | null;
  inventory_site_list_id: string | null;
  received_at: string;
  vendor_bill_number: string | null;
  vendor_bill_date: string | null;
  memo: string | null;
  lines: QbItemReceiptModPayloadLine[];
}

export const enqueueQbItemReceiptModStep = createStep(
  "enqueue-qb-item-receipt-mod",
  async (
    input: EnqueueQbItemReceiptModStepInput,
    { container }
  ): Promise<StepResponse<EnqueueQbItemReceiptModStepOutput, null>> => {
    if (!input.should_enqueue) {
      return new StepResponse({ pipeline_id: null, enqueued: false }, null);
    }

    const knex = (container as any).resolve("__pg_connection__");

    const headerRows: any = await knex.raw(
      `SELECT
         r.id                              AS receipt_id,
         r.number                          AS receipt_number,
         r.purchase_order_id               AS po_id,
         r.qb_item_receipt_list_id         AS txn_id,
         r.qb_edit_sequence,
         r.received_at,
         r.vendor_bill_number,
         r.vendor_bill_date,
         po.number                         AS po_number,
         po.vendor_qb_list_id_snapshot     AS vendor_qb_list_id,
         po.vendor_name_snapshot           AS vendor_name,
         po.qb_purchase_order_list_id      AS qb_po_list_id,
         po.memo                           AS memo,
         pipe.id                           AS pipeline_id,
         pipe.status                       AS pipe_status,
         pipe.void_status                  AS pipe_void_status,
         pipe.mod_status                   AS pipe_mod_status
       FROM purchase_order_receipt r
       JOIN purchase_order po
         ON po.id = r.purchase_order_id
       JOIN qb_item_receipt_pipeline pipe
         ON pipe.purchase_order_receipt_id = r.id
       WHERE r.id = ?`,
      [input.receipt_id]
    );
    const header = headerRows?.rows?.[0] ?? headerRows?.[0];
    if (!header) {
      throw new Error(
        `enqueueQbItemReceiptMod: receipt ${input.receipt_id} or its pipeline row not found`
      );
    }

    if (header.pipe_status !== "synced") {
      throw new Error(
        `enqueueQbItemReceiptMod: pipeline status is '${header.pipe_status}', expected 'synced' — ItemReceipt must be in QB before Mod is enqueued`
      );
    }
    if (
      header.pipe_void_status &&
      header.pipe_void_status !== "completed" &&
      header.pipe_void_status !== "failed_permanent"
    ) {
      throw new Error(
        `enqueueQbItemReceiptMod: receipt has void_status='${header.pipe_void_status}' — refusing to Mod a receipt mid-void`
      );
    }
    if (
      header.pipe_mod_status === "waiting" ||
      header.pipe_mod_status === "submitted" ||
      header.pipe_mod_status === "error"
    ) {
      throw new Error(
        `enqueueQbItemReceiptMod: receipt already has mod_status='${header.pipe_mod_status}' — wait for it to complete or fail`
      );
    }
    if (!header.txn_id) {
      throw new Error(
        `enqueueQbItemReceiptMod: receipt has no qb_item_receipt_list_id (TxnID) — cannot build ModRq`
      );
    }

    const lineRows: any = await knex.raw(
      `SELECT
         rl.id                            AS receipt_line_id,
         rl.purchase_order_line_id        AS po_line_id,
         rl.qb_item_list_id_snapshot      AS qb_item_list_id,
         rl.sku_snapshot                  AS sku,
         rl.description_snapshot          AS description,
         rl.qty_received_now              AS qty_received_now,
         COALESCE(rl.unit_cost_cents_override, pol.unit_cost_cents)
                                          AS unit_cost_cents,
         pol.qb_txn_line_id               AS qb_po_txn_line_id
       FROM purchase_order_receipt_line rl
       JOIN purchase_order_line pol
         ON pol.id = rl.purchase_order_line_id
       WHERE rl.purchase_order_receipt_id = ?
         AND rl.qty_received_now > 0
       ORDER BY rl.id ASC`,
      [input.receipt_id]
    );
    const lines: any[] = lineRows?.rows ?? lineRows ?? [];

    if (lines.length === 0) {
      throw new Error(
        `enqueueQbItemReceiptMod: receipt ${input.receipt_id} has no lines with qty_received_now > 0 — nothing to send`
      );
    }

    const payload: QbItemReceiptModPayload = {
      txn_id: header.txn_id,
      edit_sequence: header.qb_edit_sequence ?? null,
      po_id: header.po_id,
      po_number: header.po_number,
      receipt_id: header.receipt_id,
      receipt_number: header.receipt_number,
      vendor_qb_list_id: header.vendor_qb_list_id,
      vendor_name: header.vendor_name,
      qb_po_list_id: header.qb_po_list_id ?? null,
      inventory_site_list_id: null,
      received_at: new Date(header.received_at).toISOString(),
      vendor_bill_number: header.vendor_bill_number ?? null,
      vendor_bill_date: header.vendor_bill_date
        ? new Date(header.vendor_bill_date).toISOString()
        : null,
      memo: header.memo ?? null,
      lines: lines.map((l) => ({
        receipt_line_id: String(l.receipt_line_id),
        po_line_id: String(l.po_line_id),
        qb_item_list_id: String(l.qb_item_list_id ?? ""),
        qb_po_txn_line_id: l.qb_po_txn_line_id
          ? String(l.qb_po_txn_line_id)
          : null,
        sku: String(l.sku ?? ""),
        description: String(l.description ?? ""),
        qty_received_now: Number(l.qty_received_now),
        unit_cost_cents: Number(l.unit_cost_cents),
      })),
    };

    await knex.raw(
      `UPDATE qb_item_receipt_pipeline
          SET mod_status        = 'waiting',
              mod_payload       = ?::jsonb,
              mod_operation_id  = NULL,
              mod_retries       = 0,
              mod_last_error    = NULL,
              mod_next_retry_at = NULL,
              mod_synced_at     = NULL,
              updated_at        = NOW()
        WHERE id = ?`,
      [JSON.stringify(payload), header.pipeline_id]
    );

    return new StepResponse(
      { pipeline_id: String(header.pipeline_id), enqueued: true },
      null
    );
  }
);

/**
 * src/workflows/purchase-orders/receive-purchase-order.ts
 *
 * Records a physical reception against a submitted PurchaseOrder:
 *   1. allocateReceiptSequenceStep  — reserves RCP-{seq}
 *   2. applyReceiptStockStep        — +qty on inventory_levels (compensable)
 *   3. persistReceiptStep           — creates Receipt+Lines, refreshes PO counters
 *   4. enqueueQbItemReceiptStep     — frozen JSON row in qb_item_receipt_pipeline
 *
 * The route handler is responsible for:
 *   - authenticating the user as admin OR pos_user (both may receive)
 *   - loading the PO header + lines (qb_item_list_id_snapshot MUST be set —
 *     which is guaranteed because the PO was already submitted)
 *   - validating that each requested po_line_id belongs to the PO and is
 *     still open/partial (not cancelled, not already complete)
 *   - validating sum(qty_received_now per po_line) ≤ qty_ordered - qty_received
 *
 * Stock is applied BEFORE persistence so that on a downstream failure the
 * apply-receipt-stock-step compensation can cleanly revert the deltas.
 */

import {
  createWorkflow,
  transform,
  WorkflowResponse,
} from "@medusajs/framework/workflows-sdk";

import { allocateReceiptSequenceStep } from "./steps/allocate-receipt-sequence-step";
import { applyReceiptStockStep } from "./steps/apply-receipt-stock-step";
import { enqueueQbItemReceiptStep } from "./steps/enqueue-qb-item-receipt-step";
import { persistReceiptStep } from "./steps/persist-receipt-step";
import { syncReceiptInventoryMeiliStep } from "../shared/steps/sync-receipt-inventory-meili-step";

export interface ReceivePurchaseOrderWorkflowInputLine {
  po_line_id: string;
  product_variant_id: string;
  inventory_item_id: string;
  sku_snapshot: string;
  description_snapshot: string;
  qb_item_list_id_snapshot: string | null;
  qb_po_txn_line_id: string | null;
  qty_received_now: number;
  // effective unit cost: override if provided, otherwise PO line cost
  unit_cost_cents_effective: number;
  unit_cost_cents_override: number | null;
}

export interface ReceivePurchaseOrderWorkflowInput {
  po_id: string;
  po_number: string;
  vendor_qb_list_id: string;
  vendor_name: string;
  qb_po_list_id: string | null;
  qb_inventory_site_list_id: string | null;
  received_by_user_id: string;
  stock_location_id: string;
  received_at: Date;
  vendor_bill_number: string | null;
  vendor_bill_date: Date | null;
  notes: string | null;
  // Memo forwarded to QB ItemReceipt (typically "PO-1234 bill#12345")
  qb_memo: string | null;
  lines: ReceivePurchaseOrderWorkflowInputLine[];
}

export interface ReceivePurchaseOrderWorkflowOutput {
  receipt_id: string;
  receipt_number: string;
  po_status_after: "partially_received" | "received";
  total_units_received: number;
  total_units_ordered: number;
  qb_pipeline_id: string;
}

export const receivePurchaseOrderWorkflow = createWorkflow(
  "receive-purchase-order",
  function (
    input: ReceivePurchaseOrderWorkflowInput
  ): WorkflowResponse<ReceivePurchaseOrderWorkflowOutput> {
    const seq = allocateReceiptSequenceStep({});

    const stockInput = transform({ input }, (data) => ({
      location_id: data.input.stock_location_id,
      lines: data.input.lines.map((l) => ({
        po_line_id: l.po_line_id,
        inventory_item_id: l.inventory_item_id,
        qty_received_now: l.qty_received_now,
      })),
    }));

    const stock = applyReceiptStockStep(stockInput);

    const persistInput = transform({ input, seq, stock }, (data) => ({
      po_id: data.input.po_id,
      receipt_seq: data.seq.seq,
      receipt_number: data.seq.number,
      received_by_user_id: data.input.received_by_user_id,
      stock_location_id: data.input.stock_location_id,
      received_at: data.input.received_at,
      vendor_bill_number: data.input.vendor_bill_number,
      vendor_bill_date: data.input.vendor_bill_date,
      notes: data.input.notes,
      applied: data.stock.applied,
      lines: data.input.lines.map((l) => ({
        po_line_id: l.po_line_id,
        product_variant_id: l.product_variant_id,
        inventory_item_id: l.inventory_item_id,
        sku_snapshot: l.sku_snapshot,
        description_snapshot: l.description_snapshot,
        qb_item_list_id_snapshot: l.qb_item_list_id_snapshot,
        qty_received_now: l.qty_received_now,
        unit_cost_cents_override: l.unit_cost_cents_override,
      })),
    }));

    const persisted = persistReceiptStep(persistInput);

    const enqueueInput = transform({ input, seq, persisted }, (data) => {
      // Build receipt_line_id → po_line_id map for enqueue payload
      const receiptLinesForQb = data.input.lines.map((l, i) => ({
        receipt_line_id: data.persisted.receipt_line_ids[i] as string,
        po_line_id: l.po_line_id,
        qb_item_list_id: l.qb_item_list_id_snapshot ?? "",
        qb_po_txn_line_id: l.qb_po_txn_line_id,
        sku: l.sku_snapshot,
        description: l.description_snapshot,
        qty_received_now: l.qty_received_now,
        unit_cost_cents: l.unit_cost_cents_effective,
      }));

      return {
        po_id: data.input.po_id,
        po_number: data.input.po_number,
        receipt_id: data.persisted.receipt_id,
        receipt_number: data.seq.number,
        vendor_qb_list_id: data.input.vendor_qb_list_id,
        vendor_name: data.input.vendor_name,
        qb_po_list_id: data.input.qb_po_list_id,
        inventory_site_list_id: data.input.qb_inventory_site_list_id,
        received_at: data.input.received_at,
        vendor_bill_number: data.input.vendor_bill_number,
        vendor_bill_date: data.input.vendor_bill_date,
        memo: data.input.qb_memo,
        lines: receiptLinesForQb,
      };
    });

    const queued = enqueueQbItemReceiptStep(enqueueInput);

    const meiliInput = transform({ input }, (data) => ({
      inventory_item_ids: data.input.lines.map((l) => l.inventory_item_id),
    }));
    syncReceiptInventoryMeiliStep(meiliInput);

    const response = transform({ seq, persisted, queued }, (data) => ({
      receipt_id: data.persisted.receipt_id,
      receipt_number: data.seq.number,
      po_status_after: data.persisted.po_status_after,
      total_units_received: data.persisted.total_units_received,
      total_units_ordered: data.persisted.total_units_ordered,
      qb_pipeline_id: data.queued.pipeline_id,
    }));

    return new WorkflowResponse(response);
  }
);

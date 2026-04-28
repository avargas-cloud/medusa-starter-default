/**
 * src/workflows/purchase-orders/update-purchase-order-receipt.ts
 *
 * Edits an existing PurchaseOrderReceipt:
 *   - vendor_bill_number (packing slip #) — metadata-only.
 *   - per-line qty_received_now — re-balances inventory + PO line counters.
 *
 * Pipeline:
 *   1. adjustReceiptStockStep    — applies +/- deltas on inventory_levels
 *                                  (compensable; reverses on later failure).
 *   2. persistUpdateReceiptStep  — writes receipt header (vendor_bill_number),
 *                                  receipt lines (qty_received_now), recomputes
 *                                  PO line + header counters.
 *
 * The route handler is responsible for:
 *   - rejecting if status is not 'applied' (synced/voided/pending blocked).
 *   - resolving each receipt_line_id to its (po_line_id, inventory_item_id,
 *     prior_qty_received_now) and computing delta = new_qty - prior_qty.
 *   - validating new_qty <= open_qty_at_receipt_time (caller-side).
 */

import {
  createWorkflow,
  transform,
  WorkflowResponse,
} from "@medusajs/framework/workflows-sdk";

import { adjustReceiptStockStep } from "./steps/adjust-receipt-stock-step";
import { persistUpdateReceiptStep } from "./steps/persist-update-receipt-step";

export interface UpdatePoReceiptWorkflowInputLine {
  receipt_line_id: string;
  po_line_id: string;
  inventory_item_id: string;
  new_qty: number;
  delta: number;
}

export interface UpdatePoReceiptWorkflowInput {
  receipt_id: string;
  po_id: string;
  stock_location_id: string;
  vendor_bill_number?: string | null;
  vendor_bill_number_changed: boolean;
  line_changes: UpdatePoReceiptWorkflowInputLine[];
}

export interface UpdatePoReceiptWorkflowOutput {
  receipt_id: string;
  adjusted_count: number;
  lines_updated: number;
  po_status_after: "submitted" | "partially_received" | "received";
  total_units_received: number;
}

export const updatePurchaseOrderReceiptWorkflow = createWorkflow(
  "update-purchase-order-receipt",
  function (
    input: UpdatePoReceiptWorkflowInput
  ): WorkflowResponse<UpdatePoReceiptWorkflowOutput> {
    const adjustInput = transform({ input }, (data) => ({
      location_id: data.input.stock_location_id,
      lines: data.input.line_changes
        .filter((l) => l.delta !== 0)
        .map((l) => ({
          receipt_line_id: l.receipt_line_id,
          po_line_id: l.po_line_id,
          inventory_item_id: l.inventory_item_id,
          delta: l.delta,
        })),
    }));

    const adjusted = adjustReceiptStockStep(adjustInput);

    const persistInput = transform({ input }, (data) => ({
      receipt_id: data.input.receipt_id,
      po_id: data.input.po_id,
      vendor_bill_number: data.input.vendor_bill_number,
      vendor_bill_number_changed: data.input.vendor_bill_number_changed,
      line_changes: data.input.line_changes.map((l) => ({
        receipt_line_id: l.receipt_line_id,
        po_line_id: l.po_line_id,
        new_qty: l.new_qty,
        delta: l.delta,
      })),
    }));

    const persisted = persistUpdateReceiptStep(persistInput);

    const response = transform({ adjusted, persisted }, (data) => ({
      receipt_id: data.persisted.receipt_id,
      adjusted_count: data.adjusted.adjusted.length,
      lines_updated: data.persisted.lines_updated,
      po_status_after: data.persisted.po_status_after,
      total_units_received: data.persisted.total_units_received,
    }));

    return new WorkflowResponse(response);
  }
);

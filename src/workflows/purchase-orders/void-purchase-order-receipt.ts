/**
 * src/workflows/purchase-orders/void-purchase-order-receipt.ts
 *
 * Voids a previously-applied PurchaseOrderReceipt:
 *   1. contraApplyReceiptStockStep  — -qty on inventory_levels (compensable)
 *   2. persistVoidReceiptStep       — marks receipt voided, recomputes PO status,
 *                                     flags qb_item_receipt_pipeline.void_status
 *
 * The route handler is responsible for:
 *   - verifying ADMIN role (pos_user cannot void)
 *   - loading the receipt header + receipt lines (must include po_line_id
 *     and inventory_item_id for the reversal to target the correct SKU)
 *   - rejecting if receipt.status != 'applied' and != 'synced'
 *     (already voided → no-op; pending → cancel pipeline row instead)
 *
 * Hard rule on stock: if the reversal would leave stock negative, the
 * contra-apply step throws with "Manual reconciliation required" —
 * voids cannot silently break parity (units were likely sold after the
 * original receipt and must be reconciled out of band).
 */

import {
  createWorkflow,
  transform,
  WorkflowResponse,
} from "@medusajs/framework/workflows-sdk";

import { contraApplyReceiptStockStep } from "./steps/contra-apply-receipt-stock-step";
import { persistVoidReceiptStep } from "./steps/persist-void-receipt-step";

export interface VoidPoReceiptWorkflowInputLine {
  receipt_line_id: string;
  po_line_id: string;
  inventory_item_id: string;
  qty_applied: number; // positive qty originally added to stock
}

export interface VoidPoReceiptWorkflowInput {
  receipt_id: string;
  po_id: string;
  voided_by_user_id: string;
  void_reason: string;
  stock_location_id: string;
  lines_to_reverse: VoidPoReceiptWorkflowInputLine[];
}

export interface VoidPoReceiptWorkflowOutput {
  receipt_id: string;
  reversed_count: number;
  pipeline_void_queued: number;
  po_status_after: "submitted" | "partially_received" | "received";
  total_units_received: number;
}

export const voidPurchaseOrderReceiptWorkflow = createWorkflow(
  "void-purchase-order-receipt",
  function (
    input: VoidPoReceiptWorkflowInput
  ): WorkflowResponse<VoidPoReceiptWorkflowOutput> {
    const reversed = contraApplyReceiptStockStep({
      location_id: input.stock_location_id,
      lines: input.lines_to_reverse,
    });

    const persistInput = transform({ input, reversed }, (data) => ({
      receipt_id: data.input.receipt_id,
      po_id: data.input.po_id,
      voided_by_user_id: data.input.voided_by_user_id,
      void_reason: data.input.void_reason,
      reversed: data.reversed.reversed,
    }));

    const persisted = persistVoidReceiptStep(persistInput);

    const response = transform({ reversed, persisted }, (data) => ({
      receipt_id: data.persisted.receipt_id,
      reversed_count: data.reversed.reversed.length,
      pipeline_void_queued: data.persisted.pipeline_void_queued,
      po_status_after: data.persisted.po_status_after,
      total_units_received: data.persisted.total_units_received,
    }));

    return new WorkflowResponse(response);
  }
);

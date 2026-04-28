/**
 * src/workflows/purchase-orders/delete-purchase-order-receipt.ts
 *
 * Hard-delete a PurchaseOrderReceipt. The receipt row is removed from the
 * database (FK CASCADE wipes lines + vendor_bill + qb_item_receipt_pipeline)
 * and a DELETE request is sent to QuickBooks Desktop to remove the mirror
 * ItemReceipt.
 *
 *   1. contraApplyReceiptStockStep  — -qty on inventory_levels (compensable).
 *                                     No-op if was_already_voided=true.
 *   2. persistDeleteReceiptStep     — recomputes PO line/header counters,
 *                                     then either hard-deletes immediately
 *                                     (Path A: not QB-synced) or tombstones
 *                                     status='deleted' + queues QB delete
 *                                     (Path B: QB-synced; poller finishes).
 *
 * The route handler is responsible for:
 *   - loading the receipt header + lines
 *   - rejecting if status is incompatible (not in applied/synced/voided)
 *   - detecting was_already_voided + computing lines_to_reverse correctly
 */

import {
  createWorkflow,
  transform,
  WorkflowResponse,
} from "@medusajs/framework/workflows-sdk";

import { contraApplyReceiptStockStep } from "./steps/contra-apply-receipt-stock-step";
import { persistDeleteReceiptStep } from "./steps/persist-delete-receipt-step";
import { syncReceiptInventoryMeiliStep } from "../shared/steps/sync-receipt-inventory-meili-step";

export interface DeletePoReceiptWorkflowInputLine {
  receipt_line_id: string;
  po_line_id: string;
  inventory_item_id: string;
  qty_applied: number;
}

export interface DeletePoReceiptWorkflowInput {
  receipt_id: string;
  po_id: string;
  deleted_by_user_id: string;
  delete_reason: string;
  stock_location_id: string;
  lines_to_reverse: DeletePoReceiptWorkflowInputLine[];
  was_already_voided: boolean;
  /**
   * Header-level QB TxnID copied straight from the receipt at route time.
   * The persist step uses this to decide Path A vs Path B without re-reading
   * the receipt (avoids a category of bugs where the second retrieve returns
   * a stripped row missing this field).
   */
  qb_item_receipt_list_id: string | null;
}

export interface DeletePoReceiptWorkflowOutput {
  receipt_id: string;
  reversed_count: number;
  hard_deleted: boolean;
  qb_delete_queued: boolean;
  po_status_after: "submitted" | "partially_received" | "received";
  total_units_received: number;
}

export const deletePurchaseOrderReceiptWorkflow = createWorkflow(
  "delete-purchase-order-receipt",
  function (
    input: DeletePoReceiptWorkflowInput
  ): WorkflowResponse<DeletePoReceiptWorkflowOutput> {
    const reversed = contraApplyReceiptStockStep({
      location_id: input.stock_location_id,
      lines: input.lines_to_reverse,
    });

    const persistInput = transform({ input, reversed }, (data) => ({
      receipt_id: data.input.receipt_id,
      po_id: data.input.po_id,
      deleted_by_user_id: data.input.deleted_by_user_id,
      delete_reason: data.input.delete_reason,
      reversed: data.reversed.reversed,
      was_already_voided: data.input.was_already_voided,
      qb_item_receipt_list_id: data.input.qb_item_receipt_list_id,
    }));

    const persisted = persistDeleteReceiptStep(persistInput);

    const meiliInput = transform({ input }, (data) => ({
      inventory_item_ids: data.input.lines_to_reverse.map((l) => l.inventory_item_id),
    }));
    syncReceiptInventoryMeiliStep(meiliInput);

    const response = transform({ reversed, persisted }, (data) => ({
      receipt_id: data.persisted.receipt_id,
      reversed_count: data.reversed.reversed.length,
      hard_deleted: data.persisted.hard_deleted,
      qb_delete_queued: data.persisted.qb_delete_queued,
      po_status_after: data.persisted.po_status_after,
      total_units_received: data.persisted.total_units_received,
    }));

    return new WorkflowResponse(response);
  }
);

/**
 * Hard-deletes a FactoryOrderReceipt:
 *   1. contraApplyFoReceiptStockStep    — reverses the stock movement (compensable)
 *   2. persistDeleteFoReceiptStep       — recomputes FO counters + hard-deletes the receipt row
 *   3. syncReceiptInventoryMeiliStep    — refreshes MeiliSearch inventory docs for affected items
 *
 * Unlike purchase-orders, there is no QB Path B — all deletes are hard-deletes
 * (no QB sync tombstoning required).
 */

import {
  createWorkflow,
  transform,
  WorkflowResponse,
} from "@medusajs/framework/workflows-sdk";

import { contraApplyFoReceiptStockStep } from "./steps/contra-apply-fo-receipt-stock-step";
import { persistDeleteFoReceiptStep } from "./steps/persist-delete-fo-receipt-step";
import { syncReceiptInventoryMeiliStep } from "../shared/steps/sync-receipt-inventory-meili-step";

export interface DeleteFoReceiptWorkflowInputLine {
  receipt_line_id: string;
  fo_line_id: string;
  inventory_item_id: string;
  qty_applied: number;
}

export interface DeleteFoReceiptWorkflowInput {
  receipt_id: string;
  fo_id: string;
  deleted_by_user_id: string;
  delete_reason: string;
  stock_location_id: string;
  lines_to_reverse: DeleteFoReceiptWorkflowInputLine[];
  was_already_voided: boolean;
}

export interface DeleteFoReceiptWorkflowOutput {
  receipt_id: string;
  reversed_count: number;
  hard_deleted: boolean;
  fo_status_after: "submitted" | "partially_received" | "received";
  total_units_received: number;
}

export const deleteFactoryOrderReceiptWorkflow = createWorkflow(
  "delete-factory-order-receipt",
  function (
    input: DeleteFoReceiptWorkflowInput
  ): WorkflowResponse<DeleteFoReceiptWorkflowOutput> {
    const reversed = contraApplyFoReceiptStockStep({
      location_id: input.stock_location_id,
      lines: input.lines_to_reverse,
    });

    const persistInput = transform({ input, reversed }, (data) => ({
      receipt_id: data.input.receipt_id,
      fo_id: data.input.fo_id,
      deleted_by_user_id: data.input.deleted_by_user_id,
      delete_reason: data.input.delete_reason,
      reversed: data.reversed.reversed,
      was_already_voided: data.input.was_already_voided,
    }));

    const persisted = persistDeleteFoReceiptStep(persistInput);

    const meiliInput = transform({ input }, (data) => ({
      inventory_item_ids: data.input.lines_to_reverse.map((l) => l.inventory_item_id),
    }));
    syncReceiptInventoryMeiliStep(meiliInput);

    const response = transform({ reversed, persisted }, (data) => ({
      receipt_id: data.persisted.receipt_id,
      reversed_count: data.reversed.reversed.length,
      hard_deleted: data.persisted.hard_deleted,
      fo_status_after: data.persisted.fo_status_after,
      total_units_received: data.persisted.total_units_received,
    }));

    return new WorkflowResponse(response);
  }
);

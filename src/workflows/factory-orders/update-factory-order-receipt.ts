/**
 * Edits an existing FactoryOrderReceipt:
 *   - per-line qty_received_now — re-balances inventory + FO line counters.
 *
 * Pipeline:
 *   1. adjustFoReceiptStockStep       — applies +/- deltas on inventory_levels
 *   2. persistUpdateFoReceiptStep     — writes receipt lines, recomputes counters
 */

import {
  createWorkflow,
  transform,
  WorkflowResponse,
} from "@medusajs/framework/workflows-sdk";

import { adjustFoReceiptStockStep } from "./steps/adjust-fo-receipt-stock-step";
import { persistUpdateFoReceiptStep } from "./steps/persist-update-fo-receipt-step";

export interface UpdateFoReceiptWorkflowInputLine {
  receipt_line_id: string;
  fo_line_id: string;
  inventory_item_id: string;
  new_qty: number;
  delta: number;
}

export interface UpdateFoReceiptWorkflowInput {
  receipt_id: string;
  fo_id: string;
  stock_location_id: string;
  line_changes: UpdateFoReceiptWorkflowInputLine[];
}

export interface UpdateFoReceiptWorkflowOutput {
  receipt_id: string;
  adjusted_count: number;
  lines_updated: number;
  fo_status_after: "submitted" | "partially_received" | "received";
  total_units_received: number;
}

export const updateFactoryOrderReceiptWorkflow = createWorkflow(
  "update-factory-order-receipt",
  function (
    input: UpdateFoReceiptWorkflowInput
  ): WorkflowResponse<UpdateFoReceiptWorkflowOutput> {
    const adjustInput = transform({ input }, (data) => ({
      location_id: data.input.stock_location_id,
      lines: data.input.line_changes
        .filter((l) => l.delta !== 0)
        .map((l) => ({
          receipt_line_id: l.receipt_line_id,
          fo_line_id: l.fo_line_id,
          inventory_item_id: l.inventory_item_id,
          delta: l.delta,
        })),
    }));

    const adjusted = adjustFoReceiptStockStep(adjustInput);

    const persistInput = transform({ input }, (data) => ({
      receipt_id: data.input.receipt_id,
      fo_id: data.input.fo_id,
      line_changes: data.input.line_changes.map((l) => ({
        receipt_line_id: l.receipt_line_id,
        fo_line_id: l.fo_line_id,
        new_qty: l.new_qty,
        delta: l.delta,
      })),
    }));

    const persisted = persistUpdateFoReceiptStep(persistInput);

    const response = transform({ adjusted, persisted }, (data) => ({
      receipt_id: data.persisted.receipt_id,
      adjusted_count: data.adjusted.adjusted.length,
      lines_updated: data.persisted.lines_updated,
      fo_status_after: data.persisted.fo_status_after,
      total_units_received: data.persisted.total_units_received,
    }));

    return new WorkflowResponse(response);
  }
);

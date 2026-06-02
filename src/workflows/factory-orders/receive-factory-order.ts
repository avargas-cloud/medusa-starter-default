/**
 * Records a physical reception against a submitted FactoryOrder:
 *   1. allocateFoReceiptSequenceStep       — reserves FRCP-{seq}
 *   2. applyFoReceiptStockStep             — +qty on inventory_levels at China Warehouse (compensable)
 *   3. persistFoReceiptStep                — creates Receipt+Lines, refreshes FO counters
 *   4. syncReceiptInventoryMeiliStep       — refreshes MeiliSearch inventory docs for affected items
 *
 * No QB enqueue step — factory orders are Medusa-only.
 */

import {
  createWorkflow,
  transform,
  WorkflowResponse,
} from "@medusajs/framework/workflows-sdk";

import { allocateFoReceiptSequenceStep } from "./steps/allocate-fo-receipt-sequence-step";
import { applyFoReceiptStockStep } from "./steps/apply-fo-receipt-stock-step";
import { persistFoReceiptStep } from "./steps/persist-fo-receipt-step";
import { syncReceiptInventoryMeiliStep } from "../shared/steps/sync-receipt-inventory-meili-step";
import { CHINA_LOC } from "../../lib/locations";

export interface ReceiveFactoryOrderWorkflowInputLine {
  fo_line_id: string;
  product_variant_id: string;
  inventory_item_id: string;
  sku_snapshot: string;
  description_snapshot: string;
  qty_received_now: number;
  unit_cost_cents_effective: number;
  unit_cost_cents_override: number | null;
}

export interface ReceiveFactoryOrderWorkflowInput {
  fo_id: string;
  fo_number: string;
  received_by_user_id: string;
  stock_location_id: string;
  received_at: Date;
  notes: string | null;
  lines: ReceiveFactoryOrderWorkflowInputLine[];
}

export interface ReceiveFactoryOrderWorkflowOutput {
  receipt_id: string;
  receipt_number: string;
  fo_status_after: "partially_received" | "received";
  total_units_received: number;
  total_units_ordered: number;
}

export const receiveFactoryOrderWorkflow = createWorkflow(
  "receive-factory-order",
  function (
    input: ReceiveFactoryOrderWorkflowInput
  ): WorkflowResponse<ReceiveFactoryOrderWorkflowOutput> {
    // Defense-in-depth: FO receipts must always land at China Warehouse.
    // The API layer enforces this unconditionally, but assert here as a
    // backstop against accidental callers passing the wrong location.
    transform({ input }, (data) => {
      if (data.input.stock_location_id !== CHINA_LOC) {
        throw new Error(
          `receive-factory-order: stock_location_id must be China Warehouse (${CHINA_LOC}), got ${data.input.stock_location_id}`
        );
      }
      return null;
    });

    const seq = allocateFoReceiptSequenceStep({});

    const stockInput = transform({ input }, (data) => ({
      location_id: data.input.stock_location_id,
      lines: data.input.lines.map((l) => ({
        fo_line_id: l.fo_line_id,
        inventory_item_id: l.inventory_item_id,
        qty_received_now: l.qty_received_now,
      })),
    }));

    const stock = applyFoReceiptStockStep(stockInput);

    const persistInput = transform({ input, seq, stock }, (data) => ({
      fo_id: data.input.fo_id,
      receipt_seq: data.seq.seq,
      receipt_number: data.seq.number,
      received_by_user_id: data.input.received_by_user_id,
      stock_location_id: data.input.stock_location_id,
      received_at: data.input.received_at,
      notes: data.input.notes,
      applied: data.stock.applied,
      lines: data.input.lines.map((l) => ({
        fo_line_id: l.fo_line_id,
        product_variant_id: l.product_variant_id,
        inventory_item_id: l.inventory_item_id,
        sku_snapshot: l.sku_snapshot,
        description_snapshot: l.description_snapshot,
        qty_received_now: l.qty_received_now,
        unit_cost_cents_override: l.unit_cost_cents_override,
      })),
    }));

    const persisted = persistFoReceiptStep(persistInput);

    const meiliInput = transform({ input }, (data) => ({
      inventory_item_ids: data.input.lines.map((l) => l.inventory_item_id),
    }));
    syncReceiptInventoryMeiliStep(meiliInput);

    const response = transform({ seq, persisted }, (data) => ({
      receipt_id: data.persisted.receipt_id,
      receipt_number: data.seq.number,
      fo_status_after: data.persisted.fo_status_after,
      total_units_received: data.persisted.total_units_received,
      total_units_ordered: data.persisted.total_units_ordered,
    }));

    return new WorkflowResponse(response);
  }
);

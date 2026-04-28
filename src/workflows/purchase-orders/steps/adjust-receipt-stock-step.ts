/**
 * src/workflows/purchase-orders/steps/adjust-receipt-stock-step.ts
 *
 * Applies a per-line stock DELTA when editing an existing PurchaseOrderReceipt.
 *
 *   delta > 0 → user is RECEIVING MORE → adjustInventory(+delta)
 *   delta < 0 → user is REVERSING UNITS → adjustInventory(-|delta|)
 *
 * Compensation reverses each successfully-applied delta when a later step
 * fails. Compensation failures are logged but never rethrown.
 *
 * NOTE: This step assumes the route handler has already validated that
 * delta < 0 cannot exceed prior qty_received_now (caller-side guard).
 */

import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk";
import { Modules } from "@medusajs/utils";

export interface AdjustReceiptStockStepInputLine {
  receipt_line_id: string;
  po_line_id: string;
  inventory_item_id: string;
  delta: number;
}

export interface AdjustReceiptStockStepInput {
  location_id: string;
  lines: AdjustReceiptStockStepInputLine[];
}

export interface ReceiptAdjustedDelta {
  receipt_line_id: string;
  po_line_id: string;
  inventory_item_id: string;
  delta_applied: number;
  qty_at_apply_time: number;
  new_stock: number;
}

export interface AdjustReceiptStockStepOutput {
  adjusted: ReceiptAdjustedDelta[];
}

interface CompensationContext {
  location_id: string;
  adjusted: ReceiptAdjustedDelta[];
}

interface InventoryServiceLike {
  listInventoryLevels: (
    filters: Record<string, unknown>,
    options?: { take?: number }
  ) => Promise<Array<{ inventory_item_id: string; stocked_quantity: number }>>;
  adjustInventory: (
    inventory_item_id: string,
    location_id: string,
    adjustment: number
  ) => Promise<void>;
}

export const adjustReceiptStockStep = createStep(
  "adjust-po-receipt-stock",
  async (
    input: AdjustReceiptStockStepInput,
    { container }
  ): Promise<
    StepResponse<AdjustReceiptStockStepOutput, CompensationContext>
  > => {
    const inventoryService = container.resolve(
      Modules.INVENTORY
    ) as unknown as InventoryServiceLike;

    const adjusted: ReceiptAdjustedDelta[] = [];

    for (const line of input.lines) {
      if (line.delta === 0) continue;

      const levels = await inventoryService.listInventoryLevels(
        {
          inventory_item_id: line.inventory_item_id,
          location_id: input.location_id,
        },
        { take: 1 }
      );
      const preStock = levels[0]?.stocked_quantity ?? 0;

      // Guard: don't drive stock negative when reversing units.
      if (line.delta < 0 && preStock + line.delta < 0) {
        throw new Error(
          `Cannot reduce qty on receipt line ${line.receipt_line_id}: stock at location is ${preStock}, edit would result in ${preStock + line.delta}.`
        );
      }

      await inventoryService.adjustInventory(
        line.inventory_item_id,
        input.location_id,
        line.delta
      );

      adjusted.push({
        receipt_line_id: line.receipt_line_id,
        po_line_id: line.po_line_id,
        inventory_item_id: line.inventory_item_id,
        delta_applied: line.delta,
        qty_at_apply_time: preStock,
        new_stock: preStock + line.delta,
      });
    }

    return new StepResponse(
      { adjusted },
      { location_id: input.location_id, adjusted }
    );
  },
  async (compensationContext, { container }) => {
    if (!compensationContext) return;
    const inventoryService = container.resolve(
      Modules.INVENTORY
    ) as unknown as InventoryServiceLike;
    for (const a of compensationContext.adjusted) {
      try {
        await inventoryService.adjustInventory(
          a.inventory_item_id,
          compensationContext.location_id,
          -a.delta_applied
        );
      } catch (err) {
        console.error(
          `[adjust-receipt-stock compensation] failed to revert ${a.receipt_line_id}:`,
          err
        );
      }
    }
  }
);

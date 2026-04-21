/**
 * src/workflows/purchase-orders/steps/contra-apply-receipt-stock-step.ts
 *
 * Reverses the stock movement of a previously-applied receipt when the
 * receipt is voided. For each receipt line with a non-zero qty_applied we
 * call adjustInventory with the NEGATED value.
 *
 * Hard rule: if reversing would leave stock negative, the step throws with
 * a "Manual reconciliation required" message — we never silently let a
 * void leave the ledger in a broken state.
 *
 * Compensation re-applies the original +delta if a subsequent step fails.
 */

import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk";
import { Modules } from "@medusajs/utils";

export interface ContraApplyReceiptStockStepInputLine {
  receipt_line_id: string;
  po_line_id: string;
  inventory_item_id: string;
  qty_applied: number; // the original (positive) qty to reverse
}

export interface ContraApplyReceiptStockStepInput {
  location_id: string;
  lines: ContraApplyReceiptStockStepInputLine[];
}

export interface ReceiptReversedDelta {
  receipt_line_id: string;
  po_line_id: string;
  inventory_item_id: string;
  reversed_qty: number; // negative value sent to adjustInventory
  qty_at_reverse_time: number;
  new_stock: number;
}

export interface ContraApplyReceiptStockStepOutput {
  reversed: ReceiptReversedDelta[];
}

interface CompensationContext {
  location_id: string;
  reversed: ReceiptReversedDelta[];
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

export const contraApplyReceiptStockStep = createStep(
  "contra-apply-po-receipt-stock",
  async (
    input: ContraApplyReceiptStockStepInput,
    { container }
  ): Promise<
    StepResponse<ContraApplyReceiptStockStepOutput, CompensationContext>
  > => {
    const inventoryService = container.resolve(
      Modules.INVENTORY
    ) as unknown as InventoryServiceLike;

    const reversed: ReceiptReversedDelta[] = [];

    for (const line of input.lines) {
      if (line.qty_applied === 0) continue;

      const levels = await inventoryService.listInventoryLevels(
        {
          inventory_item_id: line.inventory_item_id,
          location_id: input.location_id,
        },
        { take: 1 }
      );
      const preStock = levels[0]?.stocked_quantity ?? 0;
      const reverseBy = -line.qty_applied;

      if (preStock + reverseBy < 0) {
        throw new Error(
          `Cannot void receipt line ${line.receipt_line_id}: reversing qty_applied=${line.qty_applied} on stock=${preStock} would result in negative stock. Units were likely sold or transferred already; manual reconciliation required.`
        );
      }

      await inventoryService.adjustInventory(
        line.inventory_item_id,
        input.location_id,
        reverseBy
      );

      reversed.push({
        receipt_line_id: line.receipt_line_id,
        po_line_id: line.po_line_id,
        inventory_item_id: line.inventory_item_id,
        reversed_qty: reverseBy,
        qty_at_reverse_time: preStock,
        new_stock: preStock + reverseBy,
      });
    }

    return new StepResponse(
      { reversed },
      { location_id: input.location_id, reversed }
    );
  },
  async (compensationContext, { container }) => {
    if (!compensationContext) return;

    const inventoryService = container.resolve(
      Modules.INVENTORY
    ) as unknown as InventoryServiceLike;

    for (const r of compensationContext.reversed) {
      try {
        await inventoryService.adjustInventory(
          r.inventory_item_id,
          compensationContext.location_id,
          -r.reversed_qty
        );
      } catch (err) {
        console.error(
          `[contra-apply-receipt-stock compensation] failed to re-apply ${r.receipt_line_id}:`,
          err
        );
      }
    }
  }
);

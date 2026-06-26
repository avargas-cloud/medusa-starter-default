/**
 * src/workflows/inventory-count/steps/contra-apply-stock-step.ts
 *
 * Reverses the stock deltas of a previously-approved count. For each line
 * with a non-zero `delta_applied`, calls `adjustInventory` with the negated
 * value. Compensation re-applies the original delta on subsequent failure.
 */

import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk";
import { Modules } from "@medusajs/utils";

export interface ContraApplyStockStepInput {
  location_id: string;
  lines: Array<{
    line_id: string;
    inventory_item_id: string;
    delta_applied: number; // the original (positive or negative) delta to reverse
  }>;
}

export interface ContraAppliedDelta {
  line_id: string;
  inventory_item_id: string;
  reversed_delta: number; // the value sent to adjustInventory (== -delta_applied)
  qty_at_reverse_time: number;
  new_stock: number;
}

export interface ContraApplyStockStepOutput {
  reversed: ContraAppliedDelta[];
}

interface CompensationContext {
  location_id: string;
  reversed: ContraAppliedDelta[];
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

export const contraApplyStockStep = createStep(
  "contra-apply-inventory-count-stock",
  async (
    input: ContraApplyStockStepInput,
    { container }
  ): Promise<StepResponse<ContraApplyStockStepOutput, CompensationContext>> => {
    const inventoryService = container.resolve(
      Modules.INVENTORY
    ) as unknown as InventoryServiceLike;

    const reversed: ContraAppliedDelta[] = [];

    for (const line of input.lines) {
      if (line.delta_applied === 0) continue;

      const levels = await inventoryService.listInventoryLevels(
        {
          inventory_item_id: line.inventory_item_id,
          location_id: input.location_id,
        },
        { take: 1 }
      );
      const preStock = levels[0]?.stocked_quantity ?? 0;
      const reverseBy = -line.delta_applied;

      // Negative on-hand is allowed system-wide (a unit can be sold before its
      // PO receipt is recorded; QB Desktop permits it), so a void reverses the
      // delta literally and keeps exact parity even if the result is negative —
      // consistent with the apply path, which no longer blocks on negativity.

      await inventoryService.adjustInventory(
        line.inventory_item_id,
        input.location_id,
        reverseBy
      );

      reversed.push({
        line_id: line.line_id,
        inventory_item_id: line.inventory_item_id,
        reversed_delta: reverseBy,
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
          -r.reversed_delta
        );
      } catch (err) {
        console.error(
          `[contra-apply-stock compensation] failed to re-apply ${r.line_id}:`,
          err
        );
      }
    }
  }
);

/**
 * src/workflows/inventory-count/steps/apply-stock-deltas-step.ts
 *
 * Applies inventory deltas atomically per line via inventoryModule.adjustInventory.
 * On any subsequent step failure, the compensation function reverts each
 * successfully-applied delta by calling adjustInventory with the negated value.
 */

import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk";
import { Modules } from "@medusajs/utils";

import type { ClassifiedLine } from "./classify-lines-step";

export interface ApplyStockDeltasStepInput {
  location_id: string;
  toApply: ClassifiedLine[];
}

export interface AppliedDelta {
  line_id: string;
  inventory_item_id: string;
  delta_applied: number;
  qty_at_apply_time: number; // pre-apply snapshot for audit
  new_stock: number;
}

export interface ApplyStockDeltasStepOutput {
  applied: AppliedDelta[];
}

interface CompensationContext {
  location_id: string;
  applied: AppliedDelta[];
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

export const applyStockDeltasStep = createStep(
  "apply-inventory-count-stock-deltas",
  async (
    input: ApplyStockDeltasStepInput,
    { container }
  ): Promise<StepResponse<ApplyStockDeltasStepOutput, CompensationContext>> => {
    const inventoryService = container.resolve(
      Modules.INVENTORY
    ) as unknown as InventoryServiceLike;

    const applied: AppliedDelta[] = [];

    for (const line of input.toApply) {
      const levels = await inventoryService.listInventoryLevels(
        {
          inventory_item_id: line.inventory_item_id,
          location_id: input.location_id,
        },
        { take: 1 }
      );
      const preStock = levels[0]?.stocked_quantity ?? 0;

      await inventoryService.adjustInventory(
        line.inventory_item_id,
        input.location_id,
        line.effective_delta
      );

      applied.push({
        line_id: line.line_id,
        inventory_item_id: line.inventory_item_id,
        delta_applied: line.effective_delta,
        qty_at_apply_time: preStock,
        new_stock: preStock + line.effective_delta,
      });
    }

    return new StepResponse(
      { applied },
      { location_id: input.location_id, applied }
    );
  },
  async (compensationContext, { container }) => {
    if (!compensationContext) return;

    const inventoryService = container.resolve(
      Modules.INVENTORY
    ) as unknown as InventoryServiceLike;

    for (const a of compensationContext.applied) {
      try {
        await inventoryService.adjustInventory(
          a.inventory_item_id,
          compensationContext.location_id,
          -a.delta_applied
        );
      } catch (err) {
        // Compensation failures are logged but do not throw — throwing here
        // would mask the original failure. Operator must reconcile via
        // /admin/inventory-counts/:id detail + manual stock review.
        console.error(
          `[apply-stock-deltas compensation] failed to revert ${a.line_id}:`,
          err
        );
      }
    }
  }
);

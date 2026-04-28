import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk";
import { Modules } from "@medusajs/utils";

export interface AdjustFoReceiptStockStepInputLine {
  receipt_line_id: string;
  fo_line_id: string;
  inventory_item_id: string;
  delta: number;
}

export interface AdjustFoReceiptStockStepInput {
  location_id: string;
  lines: AdjustFoReceiptStockStepInputLine[];
}

export interface FoReceiptAdjustedDelta {
  receipt_line_id: string;
  fo_line_id: string;
  inventory_item_id: string;
  delta_applied: number;
  qty_at_apply_time: number;
  new_stock: number;
}

export interface AdjustFoReceiptStockStepOutput {
  adjusted: FoReceiptAdjustedDelta[];
}

interface CompensationContext {
  location_id: string;
  adjusted: FoReceiptAdjustedDelta[];
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

export const adjustFoReceiptStockStep = createStep(
  "adjust-fo-receipt-stock",
  async (
    input: AdjustFoReceiptStockStepInput,
    { container }
  ): Promise<StepResponse<AdjustFoReceiptStockStepOutput, CompensationContext>> => {
    const inventoryService = container.resolve(
      Modules.INVENTORY
    ) as unknown as InventoryServiceLike;

    const adjusted: FoReceiptAdjustedDelta[] = [];

    for (const line of input.lines) {
      if (line.delta === 0) continue;

      const levels = await inventoryService.listInventoryLevels(
        { inventory_item_id: line.inventory_item_id, location_id: input.location_id },
        { take: 1 }
      );
      const preStock = levels[0]?.stocked_quantity ?? 0;

      if (line.delta < 0 && preStock + line.delta < 0) {
        throw new Error(
          `Cannot reduce qty on receipt line ${line.receipt_line_id}: stock=${preStock}, edit would result in ${preStock + line.delta}.`
        );
      }

      await inventoryService.adjustInventory(
        line.inventory_item_id,
        input.location_id,
        line.delta
      );

      adjusted.push({
        receipt_line_id: line.receipt_line_id,
        fo_line_id: line.fo_line_id,
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
          `[adjust-fo-receipt-stock compensation] failed to revert ${a.receipt_line_id}:`,
          err
        );
      }
    }
  }
);

import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk";
import { Modules } from "@medusajs/utils";

export interface ApplyFoReceiptStockStepInputLine {
  fo_line_id: string;
  inventory_item_id: string;
  qty_received_now: number;
}

export interface ApplyFoReceiptStockStepInput {
  location_id: string;
  lines: ApplyFoReceiptStockStepInputLine[];
}

export interface FoReceiptAppliedDelta {
  fo_line_id: string;
  inventory_item_id: string;
  qty_applied: number;
  qty_at_apply_time: number;
  new_stock: number;
}

export interface ApplyFoReceiptStockStepOutput {
  applied: FoReceiptAppliedDelta[];
}

interface CompensationContext {
  location_id: string;
  applied: FoReceiptAppliedDelta[];
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

export const applyFoReceiptStockStep = createStep(
  "apply-fo-receipt-stock",
  async (
    input: ApplyFoReceiptStockStepInput,
    { container }
  ): Promise<StepResponse<ApplyFoReceiptStockStepOutput, CompensationContext>> => {
    const inventoryService = container.resolve(
      Modules.INVENTORY
    ) as unknown as InventoryServiceLike;

    const applied: FoReceiptAppliedDelta[] = [];

    for (const line of input.lines) {
      if (line.qty_received_now <= 0) {
        throw new Error(
          `Receipt line for FO line ${line.fo_line_id} has qty_received_now=${line.qty_received_now}; must be > 0`
        );
      }

      const levels = await inventoryService.listInventoryLevels(
        { inventory_item_id: line.inventory_item_id, location_id: input.location_id },
        { take: 1 }
      );
      const preStock = levels[0]?.stocked_quantity ?? 0;

      await inventoryService.adjustInventory(
        line.inventory_item_id,
        input.location_id,
        line.qty_received_now
      );

      applied.push({
        fo_line_id: line.fo_line_id,
        inventory_item_id: line.inventory_item_id,
        qty_applied: line.qty_received_now,
        qty_at_apply_time: preStock,
        new_stock: preStock + line.qty_received_now,
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
          -a.qty_applied
        );
      } catch (err) {
        console.error(
          `[apply-fo-receipt-stock compensation] failed to revert ${a.fo_line_id}:`,
          err
        );
      }
    }
  }
);

import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk";
import { Modules } from "@medusajs/utils";

import { atomicStockMove, type KnexLike } from "./atomic-stock-move";

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
  ) => Promise<
    Array<{
      inventory_item_id: string;
      stocked_quantity: number;
      reserved_quantity?: number;
    }>
  >;
  adjustInventory: (
    inventory_item_id: string,
    location_id: string,
    adjustment: number
  ) => Promise<void>;
  createInventoryLevels: (
    data: Array<{
      inventory_item_id: string;
      location_id: string;
      stocked_quantity?: number;
    }>
  ) => Promise<unknown>;
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
    const knex = (
      container as unknown as { resolve: (k: string) => KnexLike }
    ).resolve("__pg_connection__");

    const adjusted: FoReceiptAdjustedDelta[] = [];

    for (const line of input.lines) {
      if (line.delta === 0) continue;

      const levels = await inventoryService.listInventoryLevels(
        { inventory_item_id: line.inventory_item_id, location_id: input.location_id },
        { take: 1 }
      );
      const preStock = levels[0]?.stocked_quantity ?? 0;
      const reserved = levels[0]?.reserved_quantity ?? 0;

      // A positive receipt into a location must always be possible: if the item
      // has no inventory_level here yet, create one at 0 (in sync via the
      // module) before the atomic move (a raw UPDATE would no-op on 0 rows).
      if (levels.length === 0 && line.delta > 0) {
        await inventoryService.createInventoryLevels([
          {
            inventory_item_id: line.inventory_item_id,
            location_id: input.location_id,
            stocked_quantity: 0,
          },
        ]);
      }

      // Atomic availability-guarded move (see atomicStockMove). rowCount 0 ⇒
      // the guard rejected — only possible for a decrement.
      const ok = await atomicStockMove(
        knex,
        line.inventory_item_id,
        input.location_id,
        line.delta
      );
      if (!ok) {
        const newStock = preStock + line.delta;
        if (newStock < 0) {
          throw new Error(
            `Cannot reduce qty on receipt line ${line.receipt_line_id}: stock=${preStock}, edit would result in ${newStock}.`
          );
        }
        throw new Error(
          `RESERVED_BLOCK: Cannot reduce receipt line ${line.receipt_line_id} (item ${line.inventory_item_id}): China stocked=${preStock}, reserved=${reserved}; reducing by ${-line.delta} would leave ${newStock} stocked, below ${reserved} reserved (negative availability). Unwind the reservation/transfer/sale first.`
        );
      }

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
    const knex = (
      container as unknown as { resolve: (k: string) => KnexLike }
    ).resolve("__pg_connection__");
    for (const a of compensationContext.adjusted) {
      try {
        // Unconditional reverse (compensation must always apply); keeps the
        // numeric + raw_* columns in sync via the same atomic move.
        await atomicStockMove(
          knex,
          a.inventory_item_id,
          compensationContext.location_id,
          -a.delta_applied,
          false
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

import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk";
import { Modules } from "@medusajs/utils";

import { atomicStockMove, type KnexLike } from "./atomic-stock-move";

export interface ContraApplyFoReceiptStockStepInputLine {
  receipt_line_id: string;
  fo_line_id: string;
  inventory_item_id: string;
  qty_applied: number;
}

export interface ContraApplyFoReceiptStockStepInput {
  location_id: string;
  lines: ContraApplyFoReceiptStockStepInputLine[];
}

export interface FoReceiptReversedDelta {
  receipt_line_id: string;
  fo_line_id: string;
  inventory_item_id: string;
  reversed_qty: number;
  qty_at_reverse_time: number;
  new_stock: number;
}

export interface ContraApplyFoReceiptStockStepOutput {
  reversed: FoReceiptReversedDelta[];
}

interface CompensationContext {
  location_id: string;
  reversed: FoReceiptReversedDelta[];
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
}

export const contraApplyFoReceiptStockStep = createStep(
  "contra-apply-fo-receipt-stock",
  async (
    input: ContraApplyFoReceiptStockStepInput,
    { container }
  ): Promise<StepResponse<ContraApplyFoReceiptStockStepOutput, CompensationContext>> => {
    const inventoryService = container.resolve(
      Modules.INVENTORY
    ) as unknown as InventoryServiceLike;
    const knex = (
      container as unknown as { resolve: (k: string) => KnexLike }
    ).resolve("__pg_connection__");

    const reversed: FoReceiptReversedDelta[] = [];

    for (const line of input.lines) {
      if (line.qty_applied === 0) continue;

      const levels = await inventoryService.listInventoryLevels(
        { inventory_item_id: line.inventory_item_id, location_id: input.location_id },
        { take: 1 }
      );
      const preStock = levels[0]?.stocked_quantity ?? 0;
      const reserved = levels[0]?.reserved_quantity ?? 0;
      const reverseBy = -line.qty_applied;

      // Atomic, availability-guarded reversal (see atomicStockMove). Voiding a
      // receipt removes stocked_quantity; if those units are already reserved
      // (transfers / draft orders / sales), the guard rejects (rowCount 0) so
      // the reservation isn't stranded. Block; unwind the reservation first.
      const ok = await atomicStockMove(
        knex,
        line.inventory_item_id,
        input.location_id,
        reverseBy
      );
      if (!ok) {
        const newStock = preStock + reverseBy;
        if (newStock < 0) {
          throw new Error(
            `Cannot void receipt line ${line.receipt_line_id}: reversing qty_applied=${line.qty_applied} on stock=${preStock} would result in negative stock. Manual reconciliation required.`
          );
        }
        throw new Error(
          `RESERVED_BLOCK: Cannot void receipt line ${line.receipt_line_id} (item ${line.inventory_item_id}): China stocked=${preStock}, reserved=${reserved}; reversing ${line.qty_applied} would leave ${newStock} stocked, below ${reserved} reserved (negative availability). Unwind the reservation/transfer/sale first.`
        );
      }

      reversed.push({
        receipt_line_id: line.receipt_line_id,
        fo_line_id: line.fo_line_id,
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

    const knex = (
      container as unknown as { resolve: (k: string) => KnexLike }
    ).resolve("__pg_connection__");

    for (const r of compensationContext.reversed) {
      try {
        await atomicStockMove(
          knex,
          r.inventory_item_id,
          compensationContext.location_id,
          -r.reversed_qty,
          false
        );
      } catch (err) {
        console.error(
          `[contra-apply-fo-receipt-stock compensation] failed to re-apply ${r.receipt_line_id}:`,
          err
        );
      }
    }
  }
);

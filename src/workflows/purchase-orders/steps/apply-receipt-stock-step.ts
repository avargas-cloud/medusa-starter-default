/**
 * src/workflows/purchase-orders/steps/apply-receipt-stock-step.ts
 *
 * Applies the +qty stock movement for each line in a receipt request.
 * Mirror of inventory-count/apply-stock-deltas-step, but:
 *   - Deltas are always POSITIVE (merchandise arriving).
 *   - No projected-negative guard — the receipt can only increase stock.
 *
 * Compensation reverts each successfully-applied delta when a later step
 * fails. Compensation failures are logged but never rethrown (rethrowing
 * would mask the original error — operator must reconcile via admin UI).
 */

import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk";
import { Modules } from "@medusajs/utils";

export interface ApplyReceiptStockStepInputLine {
  po_line_id: string;
  inventory_item_id: string;
  qty_received_now: number;
}

export interface ApplyReceiptStockStepInput {
  location_id: string;
  lines: ApplyReceiptStockStepInputLine[];
}

export interface ReceiptAppliedDelta {
  po_line_id: string;
  inventory_item_id: string;
  qty_applied: number;
  qty_at_apply_time: number;
  new_stock: number;
}

export interface ApplyReceiptStockStepOutput {
  applied: ReceiptAppliedDelta[];
}

interface CompensationContext {
  location_id: string;
  applied: ReceiptAppliedDelta[];
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
  createInventoryLevels: (
    data: Array<{
      inventory_item_id: string;
      location_id: string;
      stocked_quantity?: number;
    }>
  ) => Promise<unknown>;
}

export const applyReceiptStockStep = createStep(
  "apply-po-receipt-stock",
  async (
    input: ApplyReceiptStockStepInput,
    { container }
  ): Promise<
    StepResponse<ApplyReceiptStockStepOutput, CompensationContext>
  > => {
    const inventoryService = container.resolve(
      Modules.INVENTORY
    ) as unknown as InventoryServiceLike;

    const applied: ReceiptAppliedDelta[] = [];

    for (const line of input.lines) {
      if (line.qty_received_now <= 0) {
        throw new Error(
          `Receipt line for PO line ${line.po_line_id} has qty_received_now=${line.qty_received_now}; must be > 0`
        );
      }

      const levels = await inventoryService.listInventoryLevels(
        {
          inventory_item_id: line.inventory_item_id,
          location_id: input.location_id,
        },
        { take: 1 }
      );
      const preStock = levels[0]?.stocked_quantity ?? 0;

      // Defense in depth: receiving merchandise into a location must always be
      // possible. If the item has no inventory_level here yet (e.g. a product
      // created without a level — production incident 2026-05-22), create one
      // at 0 before adjusting. adjustInventory throws on a missing level.
      if (levels.length === 0) {
        await inventoryService.createInventoryLevels([
          {
            inventory_item_id: line.inventory_item_id,
            location_id: input.location_id,
            stocked_quantity: 0,
          },
        ]);
      }

      await inventoryService.adjustInventory(
        line.inventory_item_id,
        input.location_id,
        line.qty_received_now
      );

      applied.push({
        po_line_id: line.po_line_id,
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
          `[apply-receipt-stock compensation] failed to revert ${a.po_line_id}:`,
          err
        );
      }
    }
  }
);

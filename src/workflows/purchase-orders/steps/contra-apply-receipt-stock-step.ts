/**
 * src/workflows/purchase-orders/steps/contra-apply-receipt-stock-step.ts
 *
 * Reverses the stock movement of a previously-applied receipt when the
 * receipt is voided. For each receipt line with a non-zero qty_applied we
 * call adjustInventory with the NEGATED value.
 *
 * [SUPERSEDED → 2026-08-04] The old hard rule threw "Manual reconciliation
 * required" when reversing would leave stock negative. It now WARNS instead:
 * a receipt whose units were already sold is precisely the case that needs
 * undoing, and blocking it stranded the receipt while the inventory count
 * that resolves the discrepancy still had to happen. See
 * lib/purchase-orders/receipt-stock-warnings.ts.
 *
 * Compensation re-applies the original +delta if a subsequent step fails.
 */

import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk";
import { Modules } from "@medusajs/utils";

import {
  buildStockWarning,
  type ReceiptStockWarning,
} from "../../../lib/purchase-orders/receipt-stock-warnings";

export interface ContraApplyReceiptStockStepInputLine {
  receipt_line_id: string;
  po_line_id: string;
  inventory_item_id: string;
  /** For warning wording only; never used to match or write. */
  sku?: string | null;
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
  warnings: ReceiptStockWarning[];
}

interface CompensationContext {
  location_id: string;
  reversed: ReceiptReversedDelta[];
}

interface InventoryServiceLike {
  listInventoryLevels: (
    filters: Record<string, unknown>,
    options?: { take?: number }
  ) => Promise<
    Array<{
      inventory_item_id: string;
      stocked_quantity: number;
      reserved_quantity: number;
    }>
  >;
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
    const warnings: ReceiptStockWarning[] = [];

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
      const preReserved = Number(levels[0]?.reserved_quantity ?? 0);
      const reverseBy = -line.qty_applied;

      // Negative stock and stranded reservations WARN, they do not block
      // (2026-08-04). An inventory count is what settles the discrepancy.
      const warning = buildStockWarning({
        receipt_line_id: line.receipt_line_id,
        inventory_item_id: line.inventory_item_id,
        sku: line.sku ?? null,
        stock_before: preStock,
        stock_after: preStock + reverseBy,
        reserved: preReserved,
      });
      if (warning) warnings.push(warning);

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
      { reversed, warnings },
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

/**
 * src/workflows/vendor-credits/adjust-vendor-credit-stock.ts
 *
 * Stock side of a vendor credit that returns goods (plan
 * `vc-po-return-20260911`). Posting the credit takes the returned units OUT
 * of the PO's location (`apply`: −qty per line); voiding it puts them back
 * (`reverse`: +qty). Same shape as `delete-purchase-order-receipt.ts`:
 *
 *   1. adjustVendorCreditStockStep — Inventory module `adjustInventory`
 *      per line, compensable (re-applies the opposite delta).
 *   2. markVendorCreditStockStep   — stamps `stock_applied_at` /
 *      `stock_reversed_at` on the credit (the idempotency mark
 *      `decideStockMovement` reads); compensable (clears it).
 *   3. syncReceiptInventoryMeiliStep — belt-and-suspenders Meili parity
 *      (the PG trigger queues it anyway).
 *
 * Negative stock WARNS, it does not block (owner policy 2026-08-04, see
 * `receipt-stock-warnings.ts`): units already sold between receiving and the
 * return are an inventory discrepancy for a count to settle, not a reason
 * to refuse recording the return.
 */

import {
  createStep,
  createWorkflow,
  StepResponse,
  transform,
  WorkflowResponse,
} from "@medusajs/framework/workflows-sdk";
import { Modules } from "@medusajs/utils";

import { buildStockWarning } from "../../lib/purchase-orders/receipt-stock-warnings";
import type { StockDirection, VendorCreditStockLine } from "../../lib/vendor-credits/stock-lines";
import { syncReceiptInventoryMeiliStep } from "../shared/steps/sync-receipt-inventory-meili-step";

export interface AdjustVendorCreditStockInput {
  credit_id: string;
  direction: StockDirection;
  location_id: string;
  lines: VendorCreditStockLine[];
}

export interface VendorCreditStockWarning {
  code: "stock_goes_negative" | "stock_below_reserved";
  credit_line_id: string;
  inventory_item_id: string;
  sku: string | null;
  stock_before: number;
  stock_after: number;
  reserved: number;
  message: string;
}

export interface VendorCreditStockDelta {
  credit_line_id: string;
  inventory_item_id: string;
  delta: number;
  stock_before: number;
  stock_after: number;
}

export interface AdjustVendorCreditStockOutput {
  credit_id: string;
  direction: StockDirection;
  adjusted: VendorCreditStockDelta[];
  warnings: VendorCreditStockWarning[];
}

interface InventoryServiceLike {
  listInventoryLevels: (
    filters: Record<string, unknown>,
    options?: { take?: number }
  ) => Promise<Array<{ inventory_item_id: string; stocked_quantity: number; reserved_quantity: number }>>;
  adjustInventory: (inventory_item_id: string, location_id: string, adjustment: number) => Promise<void>;
}

interface KnexLike {
  raw: (sql: string, bindings?: unknown[]) => Promise<{ rowCount?: number; rows: unknown[] }>;
}

const adjustVendorCreditStockStep = createStep(
  "adjust-vendor-credit-stock",
  async (
    input: AdjustVendorCreditStockInput,
    { container }
  ): Promise<StepResponse<{ adjusted: VendorCreditStockDelta[]; warnings: VendorCreditStockWarning[] }, { location_id: string; adjusted: VendorCreditStockDelta[] }>> => {
    const inventoryService = container.resolve(Modules.INVENTORY) as unknown as InventoryServiceLike;
    const sign = input.direction === "apply" ? -1 : 1;
    const adjusted: VendorCreditStockDelta[] = [];
    const warnings: VendorCreditStockWarning[] = [];

    for (const line of input.lines) {
      if (line.qty <= 0) continue;
      const levels = await inventoryService.listInventoryLevels(
        { inventory_item_id: line.inventory_item_id, location_id: input.location_id },
        { take: 1 }
      );
      const before = Number(levels[0]?.stocked_quantity ?? 0);
      const reserved = Number(levels[0]?.reserved_quantity ?? 0);
      const delta = sign * line.qty;
      const after = before + delta;

      const warning = buildStockWarning({
        receipt_line_id: line.credit_line_id,
        inventory_item_id: line.inventory_item_id,
        sku: line.sku,
        stock_before: before,
        stock_after: after,
        reserved,
      });
      if (warning) {
        warnings.push({
          code: warning.code,
          credit_line_id: line.credit_line_id,
          inventory_item_id: warning.inventory_item_id,
          sku: warning.sku,
          stock_before: warning.stock_before,
          stock_after: warning.stock_after,
          reserved: warning.reserved,
          message: warning.message,
        });
      }

      await inventoryService.adjustInventory(line.inventory_item_id, input.location_id, delta);
      adjusted.push({
        credit_line_id: line.credit_line_id,
        inventory_item_id: line.inventory_item_id,
        delta,
        stock_before: before,
        stock_after: after,
      });
    }

    return new StepResponse({ adjusted, warnings }, { location_id: input.location_id, adjusted });
  },
  async (ctx, { container }) => {
    if (!ctx) return;
    const inventoryService = container.resolve(Modules.INVENTORY) as unknown as InventoryServiceLike;
    for (const a of ctx.adjusted) {
      try {
        await inventoryService.adjustInventory(a.inventory_item_id, ctx.location_id, -a.delta);
      } catch (err) {
        console.error(`[adjust-vendor-credit-stock compensation] failed to undo ${a.credit_line_id}:`, err);
      }
    }
  }
);

const markVendorCreditStockStep = createStep(
  "mark-vendor-credit-stock",
  async (input: { credit_id: string; direction: StockDirection }, { container }) => {
    const knex = container.resolve("__pg_connection__") as KnexLike;
    const column = input.direction === "apply" ? "stock_applied_at" : "stock_reversed_at";
    // The `IS NULL` guard is the idempotency mark: a second run of the same
    // direction finds nothing to stamp and the step fails loudly, which
    // compensates the adjustment above instead of moving stock twice.
    const result = await knex.raw(
      `UPDATE vendor_credit SET ${column} = NOW(), updated_at = NOW()
        WHERE id = ? AND deleted_at IS NULL AND ${column} IS NULL`,
      [input.credit_id]
    );
    if ((result.rowCount ?? 0) !== 1) {
      throw new Error(`vendor credit ${input.credit_id}: ${column} already set — stock movement refused`);
    }
    return new StepResponse({ column }, { credit_id: input.credit_id, column });
  },
  async (ctx, { container }) => {
    if (!ctx) return;
    const knex = container.resolve("__pg_connection__") as KnexLike;
    await knex.raw(`UPDATE vendor_credit SET ${ctx.column} = NULL, updated_at = NOW() WHERE id = ?`, [
      ctx.credit_id,
    ]);
  }
);

export const adjustVendorCreditStockWorkflow = createWorkflow(
  "adjust-vendor-credit-stock",
  function (input: AdjustVendorCreditStockInput): WorkflowResponse<AdjustVendorCreditStockOutput> {
    const moved = adjustVendorCreditStockStep(input);
    const markInput = transform({ input }, (d) => ({ credit_id: d.input.credit_id, direction: d.input.direction }));
    markVendorCreditStockStep(markInput);
    const meiliInput = transform({ input }, (d) => ({
      inventory_item_ids: [...new Set(d.input.lines.map((l) => l.inventory_item_id))],
    }));
    syncReceiptInventoryMeiliStep(meiliInput);
    const out = transform({ input, moved }, (d) => ({
      credit_id: d.input.credit_id,
      direction: d.input.direction,
      adjusted: d.moved.adjusted,
      warnings: d.moved.warnings,
    }));
    return new WorkflowResponse(out);
  }
);

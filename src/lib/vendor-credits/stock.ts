import type { MedusaContainer } from "@medusajs/framework/types";

import {
  adjustVendorCreditStockWorkflow,
  type AdjustVendorCreditStockOutput,
} from "../../workflows/vendor-credits/adjust-vendor-credit-stock";

import type { ReviseResult } from "./revise";
import { decideStockMovement, loadVendorCreditStockState, type StockDirection } from "./stock-lines";
import type { PgClient } from "./types";

export type VendorCreditStockResult =
  | {
      moved: true;
      direction: StockDirection | "delta";
      adjusted: number;
      warnings: AdjustVendorCreditStockOutput["warnings"];
    }
  | { moved: false; reason: string };

/**
 * Runs the stock movement of a credit in one direction, or explains why
 * not. Called by the post (`apply`) and void (`reverse`) routes AFTER their
 * local commit — like the GL hook and the QB enqueue, it can never un-post
 * or un-void the credit; a failure surfaces in the response as
 * `{moved:false, reason}` for the operator (and the marks stay NULL, so a
 * retry is a plain re-run).
 */
export async function moveVendorCreditStock(
  container: MedusaContainer,
  client: PgClient,
  creditId: string,
  direction: StockDirection
): Promise<VendorCreditStockResult> {
  const state = await loadVendorCreditStockState(client, creditId);
  if (!state) return { moved: false, reason: "vendor credit not found" };
  const decision = decideStockMovement(state, direction);
  if (!decision.run) return { moved: false, reason: decision.reason };

  try {
    const { result } = await adjustVendorCreditStockWorkflow(container).run({
      input: {
        credit_id: creditId,
        direction: decision.direction,
        location_id: decision.location_id,
        lines: decision.lines,
      },
    });
    return {
      moved: true,
      direction,
      adjusted: result.adjusted.length,
      warnings: result.warnings,
    };
  } catch (err) {
    return { moved: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * A revise of a POSTED credit moves only the DIFFERENCE per PO line (signed):
 * the credit stays "stock applied", so no idempotency mark is touched. Nothing
 * to do when the revise did not change product quantities, when stock was
 * never applied (the deltas list is empty then), or when the credit has no
 * location.
 */
export async function applyVendorCreditStockDeltas(
  container: MedusaContainer,
  creditId: string,
  revised: ReviseResult
): Promise<VendorCreditStockResult> {
  if (!revised.linesChanged) return { moved: false, reason: "lines unchanged" };
  if (revised.stockDeltas.length === 0) return { moved: false, reason: "no product quantity changed" };
  if (!revised.stockLocationId) return { moved: false, reason: "purchase order has no stock location" };
  try {
    const { result } = await adjustVendorCreditStockWorkflow(container).run({
      input: {
        credit_id: creditId,
        direction: "delta",
        location_id: revised.stockLocationId,
        lines: revised.stockDeltas.map((d) => ({
          credit_line_id: d.purchase_order_line_id,
          purchase_order_line_id: d.purchase_order_line_id,
          inventory_item_id: d.inventory_item_id,
          sku: d.sku,
          qty: d.delta,
        })),
      },
    });
    return { moved: true, direction: "delta", adjusted: result.adjusted.length, warnings: result.warnings };
  } catch (err) {
    return { moved: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

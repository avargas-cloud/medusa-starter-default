import type { MedusaContainer } from "@medusajs/framework/types";

import {
  adjustVendorCreditStockWorkflow,
  type AdjustVendorCreditStockOutput,
} from "../../workflows/vendor-credits/adjust-vendor-credit-stock";

import { decideStockMovement, loadVendorCreditStockState, type StockDirection } from "./stock-lines";
import type { PgClient } from "./types";

export type VendorCreditStockResult =
  | { moved: true; direction: StockDirection; adjusted: number; warnings: AdjustVendorCreditStockOutput["warnings"] }
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

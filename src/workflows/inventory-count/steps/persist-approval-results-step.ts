/**
 * src/workflows/inventory-count/steps/persist-approval-results-step.ts
 *
 * Updates inventory_count_line rows with the final per-line outcome and
 * refreshes denormalized counters on the header. Sets header status to
 * 'approved' if every line succeeded, otherwise 'partially_applied'.
 *
 * No compensation: if this step fails, the prior applyStockDeltasStep will
 * roll back the in-memory inventory levels via its own compensation.
 */

import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk";

import { INVENTORY_COUNT_MODULE } from "../../../modules/inventory-count";
import type InventoryCountModuleService from "../../../modules/inventory-count/service";

import type { AppliedDelta } from "./apply-stock-deltas-step";
import type {
  BlockedLine,
  ClassifiedLine,
  OverriddenAuditEntry,
  SkippedLine,
  VerifiedLine,
} from "./classify-lines-step";

export interface PersistApprovalResultsStepInput {
  count_id: string;
  reviewed_by_user_id: string;
  total_lines: number;
  applied: AppliedDelta[];
  toApply: ClassifiedLine[];
  blocked: BlockedLine[];
  skipped: SkippedLine[];
  verified: VerifiedLine[];
  overrides: OverriddenAuditEntry[];
}

export interface PersistApprovalResultsStepOutput {
  status: "approved" | "partially_applied";
  total_lines_applied: number;
  total_lines_verified: number;
  total_lines_blocked: number;
  total_lines_skipped: number;
}

export const persistApprovalResultsStep = createStep(
  "persist-inventory-count-approval-results",
  async (
    input: PersistApprovalResultsStepInput,
    { container }
  ): Promise<StepResponse<PersistApprovalResultsStepOutput, null>> => {
    const service = container.resolve(
      INVENTORY_COUNT_MODULE
    ) as unknown as InventoryCountModuleService;

    const overrideByLineId = new Map<string, OverriddenAuditEntry>();
    for (const o of input.overrides) overrideByLineId.set(o.line_id, o);

    const lineUpdates: Array<Record<string, unknown>> = [];

    // Build the qb_account assignment from toApply (it contains the resolved account)
    const accountByLineId = new Map<string, string>();
    for (const a of input.toApply) {
      accountByLineId.set(a.line_id, a.qb_account_list_id);
    }

    for (const a of input.applied) {
      const override = overrideByLineId.get(a.line_id);
      lineUpdates.push({
        id: a.line_id,
        status: override ? "overridden" : "applied",
        delta_applied: a.delta_applied,
        qty_at_apply_time: a.qty_at_apply_time,
        projected_stock: a.new_stock,
        qb_account_list_id: accountByLineId.get(a.line_id) ?? null,
        override_note: override?.override_note ?? null,
      });
    }

    for (const b of input.blocked) {
      lineUpdates.push({
        id: b.line_id,
        status: "blocked",
        block_reason: b.reason,
        qty_at_apply_time: b.current_stock_now,
        override_note: b.message,
      });
    }

    for (const s of input.skipped) {
      lineUpdates.push({
        id: s.line_id,
        status: "skipped",
        override_note: s.override_note,
      });
    }

    for (const v of input.verified) {
      lineUpdates.push({
        id: v.line_id,
        status: "verified",
        delta_applied: 0,
        qty_at_apply_time: v.qty_at_apply_time,
        projected_stock: v.qty_at_apply_time, // unchanged
      });
    }

    if (lineUpdates.length > 0) {
      await service.updateInventoryCountLines(lineUpdates);
    }

    const totalApplied = input.applied.length;
    const totalVerified = input.verified.length;
    const totalBlocked = input.blocked.length;
    const totalSkipped = input.skipped.length;
    // Verified lines count as "successfully processed" for status purposes
    const totalProcessed = totalApplied + totalVerified;
    const fullySuccess =
      totalBlocked === 0 &&
      totalSkipped === 0 &&
      totalProcessed === input.total_lines;
    const finalStatus: "approved" | "partially_applied" = fullySuccess
      ? "approved"
      : "partially_applied";

    await service.updateInventoryCounts([
      {
        id: input.count_id,
        status: finalStatus,
        reviewed_by_user_id: input.reviewed_by_user_id,
        reviewed_at: new Date(),
        applied_at: new Date(),
        total_lines_applied: totalApplied,
        total_lines_blocked: totalBlocked,
      },
    ]);

    return new StepResponse(
      {
        status: finalStatus,
        total_lines_applied: totalApplied,
        total_lines_verified: totalVerified,
        total_lines_blocked: totalBlocked,
        total_lines_skipped: totalSkipped,
      },
      null
    );
  }
);

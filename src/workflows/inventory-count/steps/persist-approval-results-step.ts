/**
 * src/workflows/inventory-count/steps/persist-approval-results-step.ts
 *
 * Updates inventory_count_line rows with the final per-line outcome and
 * refreshes denormalized counters on the header. Sets header status to
 * 'approved' if every line succeeded, otherwise 'partially_applied'.
 *
 * Compensation: reverts the count back to 'submitted' and all touched lines
 * back to 'pending'. This runs when enqueueQbAdjustmentsStep fails after us,
 * keeping DB state consistent with the stock-delta compensation from
 * applyStockDeltasStep (which also reverts when enqueue fails).
 */

import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk";

import { INVENTORY_COUNT_MODULE } from "../../../modules/inventory-count";
import type InventoryCountModuleService from "../../../modules/inventory-count/service";

import type { AppliedDelta } from "./apply-stock-deltas-step";
import type {
  BlockedLine,
  ClassifiedLine,
  OverriddenAuditEntry,
  OverriddenZeroLine,
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
  overriddenZero: OverriddenZeroLine[];
  overrides: OverriddenAuditEntry[];
}

export interface PersistApprovalResultsStepOutput {
  status: "approved" | "partially_applied";
  total_lines_applied: number;
  total_lines_verified: number;
  total_lines_blocked: number;
  total_lines_skipped: number;
}

interface PersistApprovalResultsStepCompensation {
  count_id: string;
  line_ids: string[];
}

export const persistApprovalResultsStep = createStep(
  "persist-inventory-count-approval-results",
  async (
    input: PersistApprovalResultsStepInput,
    { container }
  ): Promise<
    StepResponse<
      PersistApprovalResultsStepOutput,
      PersistApprovalResultsStepCompensation
    >
  > => {
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
        // Derived from the REAL post-apply stock (a.new_stock), not the
        // pre-apply projection — stock can move between classify and apply.
        resulted_negative: a.new_stock < 0,
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
        resulted_negative: false,
      });
    }

    // Override that deliberately zeroed a real variance → audited as
    // 'overridden' (no stock move, no QB push), never silent 'verified'.
    for (const o of input.overriddenZero) {
      lineUpdates.push({
        id: o.line_id,
        status: "overridden",
        delta_applied: 0,
        qty_at_apply_time: o.qty_at_apply_time,
        projected_stock: o.qty_at_apply_time, // unchanged
        override_note: o.override_note,
        resulted_negative: false,
      });
    }

    if (lineUpdates.length > 0) {
      await service.updateInventoryCountLines(lineUpdates);
    }

    // Counters + final status are computed from ALL lines of the count, not
    // just this approval pass — a count can be approved across multiple passes
    // (partially_applied → re-approve), and the header must reflect the full
    // picture. (Pre-fix this overwrote with only the current pass, leaving
    // total_lines_applied=0 on multi-pass counts.)
    const allLines = (await service.listInventoryCountLines(
      { inventory_count_id: input.count_id },
      { take: 5000 }
    )) as Array<{ status: string }>;

    const countBy = (statuses: string[]) =>
      allLines.filter((l) => statuses.includes(l.status)).length;

    const totalApplied = countBy(["applied", "overridden"]);
    const totalVerified = countBy(["verified"]);
    const totalBlocked = countBy(["blocked"]);
    const totalSkipped = countBy(["skipped"]);
    const totalPending = countBy(["pending"]);

    // Every line resolved (none pending/blocked) → approved, else partial.
    const finalStatus: "approved" | "partially_applied" =
      totalPending === 0 && totalBlocked === 0 ? "approved" : "partially_applied";

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

    const allTouchedLineIds = [
      ...input.applied.map((a) => a.line_id),
      ...input.blocked.map((b) => b.line_id),
      ...input.skipped.map((s) => s.line_id),
      ...input.verified.map((v) => v.line_id),
      ...input.overriddenZero.map((o) => o.line_id),
    ];

    return new StepResponse(
      {
        status: finalStatus,
        total_lines_applied: totalApplied,
        total_lines_verified: totalVerified,
        total_lines_blocked: totalBlocked,
        total_lines_skipped: totalSkipped,
      },
      { count_id: input.count_id, line_ids: allTouchedLineIds }
    );
  },
  async (
    compensation: PersistApprovalResultsStepCompensation | undefined,
    { container }
  ) => {
    if (!compensation) return;
    const service = container.resolve(
      INVENTORY_COUNT_MODULE
    ) as unknown as InventoryCountModuleService;

    if (compensation.line_ids.length > 0) {
      await service.updateInventoryCountLines(
        compensation.line_ids.map((id) => ({
          id,
          status: "pending",
          delta_applied: null,
          qty_at_apply_time: null,
          projected_stock: null,
          qb_account_list_id: null,
          override_note: null,
          block_reason: null,
          resulted_negative: false,
        }))
      );
    }

    await service.updateInventoryCounts([
      {
        id: compensation.count_id,
        status: "submitted",
        reviewed_by_user_id: null,
        reviewed_at: null,
        applied_at: null,
        total_lines_applied: 0,
        total_lines_blocked: 0,
      },
    ]);
  }
);

/**
 * src/workflows/inventory-count/steps/classify-lines-step.ts
 *
 * Pure decision step (no I/O). Given live current stock + manager decisions,
 * partition lines into toApply / toBlock / toSkip and decide the
 * effective delta for each.
 *
 * Delta rule: the original counted delta is movement-invariant — applied on
 * top of whatever live stock exists at approval time, so interim sales (stock
 * down) and PO receipts (stock up) are preserved. Negative results are ALLOWED
 * and never blocked (a unit can be sold before its PO receipt is recorded; QB
 * Desktop permits negative inventory); they are flagged via `resulted_negative`
 * for review.
 *
 * delta=0 from the count → `verified` (match, audit-only). A manager OVERRIDE
 * that lands on delta=0 over a line that had a real variance is NOT a match —
 * it is a deliberate "current stock is correct, discard the variance" decision
 * → `overridden` (audited), never silently `verified`.
 */

import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk";

import type {
  ApprovalLineAction,
  InventoryCountLineBlockReason,
} from "../../../modules/inventory-count/types";

export interface ClassifyLineInput {
  line_id: string;
  product_variant_id: string;
  inventory_item_id: string;
  sku: string;
  qty_at_count_time: number;
  qty_counted: number;
  delta_original: number;
  current_stock_now: number;
  qb_account_list_id_line: string | null; // line override
  qb_account_list_id_default: string; // header default (fallback)
}

export interface ClassifyDecision {
  line_id: string;
  action: ApprovalLineAction;
  override_delta?: number;
  override_note?: string;
  qb_account_list_id?: string;
}

export interface ClassifyLinesStepInput {
  lines: ClassifyLineInput[];
  decisions: ClassifyDecision[];
}

export interface ClassifiedLine {
  line_id: string;
  inventory_item_id: string;
  product_variant_id: string;
  sku: string;
  effective_delta: number;
  projected_stock: number;
  qb_account_list_id: string;
  override_note: string | null;
}

export interface BlockedLine {
  line_id: string;
  reason: InventoryCountLineBlockReason;
  current_stock_now: number;
  attempted_delta: number;
  override_rejected: boolean; // true if a manager override would have produced negative
  message: string;
}

export interface SkippedLine {
  line_id: string;
  override_note: string;
}

export interface OverriddenAuditEntry {
  line_id: string;
  delta_original: number;
  delta_applied: number;
  override_note: string;
}

export interface VerifiedLine {
  line_id: string;
  qty_at_apply_time: number;
}

export interface OverriddenZeroLine {
  line_id: string;
  qty_at_apply_time: number;
  delta_original: number;
  override_note: string | null;
}

export interface ClassifyLinesStepOutput {
  toApply: ClassifiedLine[];
  toBlock: BlockedLine[];
  toSkip: SkippedLine[];
  toVerified: VerifiedLine[]; // counted but delta=0 — audit-only, no QB push
  // Manager override that lands on delta=0 over a line that HAD a real
  // variance — a deliberate "keep current stock, discard the count" decision.
  // Recorded as `overridden` (audited), no stock move, no QB push.
  toOverriddenZero: OverriddenZeroLine[];
  overrides: OverriddenAuditEntry[];
}

/**
 * Pure classification — exported so it can be unit-tested directly without the
 * workflow step wrapper. The step below is a thin adapter around it.
 */
export function classifyLines(
  input: ClassifyLinesStepInput
): ClassifyLinesStepOutput {
    const decisionByLine = new Map<string, ClassifyDecision>();
    for (const d of input.decisions) decisionByLine.set(d.line_id, d);

    const toApply: ClassifiedLine[] = [];
    const toBlock: BlockedLine[] = [];
    const toSkip: SkippedLine[] = [];
    const toVerified: VerifiedLine[] = [];
    const toOverriddenZero: OverriddenZeroLine[] = [];
    const overrides: OverriddenAuditEntry[] = [];

    for (const line of input.lines) {
      const decision = decisionByLine.get(line.line_id);
      const action: ApprovalLineAction = decision?.action ?? "apply";
      const accountListId =
        decision?.qb_account_list_id ??
        line.qb_account_list_id_line ??
        line.qb_account_list_id_default;

      if (action === "skip") {
        toSkip.push({
          line_id: line.line_id,
          override_note: decision?.override_note ?? "skipped by manager",
        });
        continue;
      }

      const isOverride =
        action === "override" && decision?.override_delta !== undefined;
      const effectiveDelta = isOverride
        ? (decision?.override_delta as number)
        : line.delta_original;

      if (effectiveDelta === 0) {
        if (isOverride && line.delta_original !== 0) {
          // Deliberate "keep current stock, discard the counted variance" —
          // audited as `overridden`, NOT silently treated as a clean match.
          toOverriddenZero.push({
            line_id: line.line_id,
            qty_at_apply_time: line.current_stock_now,
            delta_original: line.delta_original,
            override_note: decision?.override_note ?? null,
          });
        } else {
          // Cashier's count matched the system → verified (audit-only, no QB).
          toVerified.push({
            line_id: line.line_id,
            qty_at_apply_time: line.current_stock_now,
          });
        }
        continue;
      }

      // Delta is movement-invariant: apply on top of live stock, no negative
      // block. A negative result is allowed and flagged downstream.
      const projected = line.current_stock_now + effectiveDelta;

      toApply.push({
        line_id: line.line_id,
        inventory_item_id: line.inventory_item_id,
        product_variant_id: line.product_variant_id,
        sku: line.sku,
        effective_delta: effectiveDelta,
        projected_stock: projected,
        qb_account_list_id: accountListId,
        override_note:
          action === "override" ? (decision?.override_note ?? null) : null,
      });

      if (action === "override") {
        overrides.push({
          line_id: line.line_id,
          delta_original: line.delta_original,
          delta_applied: effectiveDelta,
          override_note: decision?.override_note ?? "",
        });
      }
    }

    return { toApply, toBlock, toSkip, toVerified, toOverriddenZero, overrides };
}

export const classifyLinesStep = createStep(
  "classify-inventory-count-lines",
  async (
    input: ClassifyLinesStepInput
  ): Promise<StepResponse<ClassifyLinesStepOutput, null>> => {
    return new StepResponse(classifyLines(input), null);
  }
);

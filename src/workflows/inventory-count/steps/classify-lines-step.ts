/**
 * src/workflows/inventory-count/steps/classify-lines-step.ts
 *
 * Pure decision step (no I/O). Given live current stock + manager decisions,
 * partition lines into toApply / toBlock / toSkip and decide the
 * effective delta for each.
 *
 * Hard rule: server NEVER allows an apply or override that would leave
 * stock negative. Inventory adjustments exist to correct discrepancies, not
 * to create new ones.
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

export interface ClassifyLinesStepOutput {
  toApply: ClassifiedLine[];
  toBlock: BlockedLine[];
  toSkip: SkippedLine[];
  toVerified: VerifiedLine[]; // counted but delta=0 — audit-only, no QB push
  overrides: OverriddenAuditEntry[];
}

export const classifyLinesStep = createStep(
  "classify-inventory-count-lines",
  async (
    input: ClassifyLinesStepInput
  ): Promise<StepResponse<ClassifyLinesStepOutput, null>> => {
    const decisionByLine = new Map<string, ClassifyDecision>();
    for (const d of input.decisions) decisionByLine.set(d.line_id, d);

    const toApply: ClassifiedLine[] = [];
    const toBlock: BlockedLine[] = [];
    const toSkip: SkippedLine[] = [];
    const toVerified: VerifiedLine[] = [];
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

      const effectiveDelta =
        action === "override" && decision?.override_delta !== undefined
          ? decision.override_delta
          : line.delta_original;

      // Delta=0 → verified (counted, matched system) — audit-only, no QB
      if (effectiveDelta === 0) {
        toVerified.push({
          line_id: line.line_id,
          qty_at_apply_time: line.current_stock_now,
        });
        continue;
      }

      const projected = line.current_stock_now + effectiveDelta;

      if (projected < 0) {
        toBlock.push({
          line_id: line.line_id,
          reason: "projected_negative",
          current_stock_now: line.current_stock_now,
          attempted_delta: effectiveDelta,
          override_rejected: action === "override",
          message:
            action === "override"
              ? `Override delta ${effectiveDelta} would leave stock at ${projected}; max allowed delta is ${-line.current_stock_now}.`
              : `Applying delta ${effectiveDelta} would leave stock at ${projected}; manager must skip or override.`,
        });
        continue;
      }

      toApply.push({
        line_id: line.line_id,
        inventory_item_id: line.inventory_item_id,
        product_variant_id: line.product_variant_id,
        sku: line.sku,
        effective_delta: effectiveDelta,
        projected_stock: projected,
        qb_account_list_id: accountListId,
        override_note:
          action === "override" ? decision?.override_note ?? null : null,
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

    return new StepResponse(
      { toApply, toBlock, toSkip, toVerified, overrides },
      null
    );
  }
);

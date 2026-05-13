/**
 * src/workflows/inventory-count/approve-inventory-count.ts
 *
 * Manager approval workflow. Composed of pure-decision + I/O steps with
 * compensation on stock deltas to guarantee atomicity:
 *
 *   1. classifyLinesStep       — partition into apply / skip / block
 *   2. applyStockDeltasStep    — adjust Medusa inventory_levels (compensable)
 *   3. persistApprovalResults  — update line/header rows with final outcome
 *   4. enqueueQbAdjustments    — create QB sync pipeline rows (one per account)
 *
 * The route handler is responsible for:
 *   - verifying manager role (requireManager)
 *   - loading the count + lines + live stock
 *   - rejecting if status != 'submitted'
 *   - calling this workflow with the prepared input
 */

import {
  createWorkflow,
  transform,
  WorkflowResponse,
} from "@medusajs/framework/workflows-sdk";

import {
  applyStockDeltasStep,
  type AppliedDelta,
} from "./steps/apply-stock-deltas-step";
import {
  classifyLinesStep,
  type ClassifyDecision,
  type ClassifyLineInput,
} from "./steps/classify-lines-step";
import { enqueueQbAdjustmentsStep } from "./steps/enqueue-qb-adjustments-step";
import { persistApprovalResultsStep } from "./steps/persist-approval-results-step";
import { syncReceiptInventoryMeiliStep } from "../shared/steps/sync-receipt-inventory-meili-step";

export interface ApproveInventoryCountWorkflowInput {
  count_id: string;
  count_number: string;
  count_memo: string;
  stock_location_id: string;
  reviewed_by_user_id: string;
  total_lines: number;
  lines: ClassifyLineInput[];
  decisions: ClassifyDecision[];
}

export interface ApproveInventoryCountWorkflowOutput {
  count_id: string;
  status: "approved" | "partially_applied";
  applied: AppliedDelta[];
  blocked: Array<{
    line_id: string;
    reason: string;
    message: string;
  }>;
  skipped: Array<{ line_id: string }>;
  qb_pipeline_ids: string[];
}

export const approveInventoryCountWorkflow = createWorkflow(
  "approve-inventory-count",
  function (
    input: ApproveInventoryCountWorkflowInput
  ): WorkflowResponse<ApproveInventoryCountWorkflowOutput> {
    const classified = classifyLinesStep({
      lines: input.lines,
      decisions: input.decisions,
    });

    const stock = applyStockDeltasStep({
      location_id: input.stock_location_id,
      toApply: classified.toApply,
    });

    const persisted = persistApprovalResultsStep({
      count_id: input.count_id,
      reviewed_by_user_id: input.reviewed_by_user_id,
      total_lines: input.total_lines,
      applied: stock.applied,
      toApply: classified.toApply,
      blocked: classified.toBlock,
      skipped: classified.toSkip,
      verified: classified.toVerified,
      overrides: classified.overrides,
    });

    const queued = enqueueQbAdjustmentsStep({
      count_id: input.count_id,
      count_number: input.count_number,
      count_memo: input.count_memo,
      toApply: classified.toApply,
      applied: stock.applied,
    });

    const meiliInput = transform({ stock, queued }, (data) => ({
      inventory_item_ids: Array.from(
        new Set(data.stock.applied.map((a) => a.inventory_item_id))
      ),
    }));

    syncReceiptInventoryMeiliStep(meiliInput);

    const response = transform(
      { input, persisted, stock, classified, queued },
      (data) => ({
        count_id: data.input.count_id,
        status: data.persisted.status,
        applied: data.stock.applied,
        blocked: data.classified.toBlock.map((b) => ({
          line_id: b.line_id,
          reason: b.reason,
          message: b.message,
        })),
        skipped: data.classified.toSkip.map((s) => ({ line_id: s.line_id })),
        qb_pipeline_ids: data.queued.pipeline_ids,
      })
    );

    return new WorkflowResponse(response);
  }
);

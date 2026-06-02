/**
 * src/workflows/inventory-count/void-inventory-count.ts
 *
 * Voids a previously approved inventory count. Two effects:
 *   1. Stock parity: contra-applies the original delta in Medusa
 *      (compensable — failure rolls back the contra-deltas).
 *   2. Audit + QB sync: marks the count 'voided', transitions lines to
 *      'voided', flags every related pipeline row's `void_status='waiting'`
 *      so the cron poller emits a TxnVoidRq to QB.
 *
 * The route handler is responsible for:
 *   - verifying manager role (requireManager)
 *   - loading the count + applied lines
 *   - rejecting if status NOT IN ('approved','partially_applied')
 *   - resolving the synced pipeline rows (those with qb_list_id) for QB void
 */

import {
  createWorkflow,
  transform,
  WorkflowResponse,
} from "@medusajs/framework/workflows-sdk";

import {
  contraApplyStockStep,
  type ContraApplyStockStepInput,
} from "./steps/contra-apply-stock-step";
import {
  persistVoidResultsStep,
  type PipelineRowToVoid,
} from "./steps/persist-void-results-step";
import { syncReceiptInventoryMeiliStep } from "../shared/steps/sync-receipt-inventory-meili-step";

export interface VoidInventoryCountWorkflowInput {
  count_id: string;
  voided_by_user_id: string;
  void_reason: string;
  stock_location_id: string;
  lines_to_reverse: ContraApplyStockStepInput["lines"];
  pipeline_rows_to_void: PipelineRowToVoid[];
}

export interface VoidInventoryCountWorkflowOutput {
  count_id: string;
  reversed_count: number;
  voided_line_count: number;
  pipeline_void_queued: number;
}

export const voidInventoryCountWorkflow = createWorkflow(
  "void-inventory-count",
  function (
    input: VoidInventoryCountWorkflowInput
  ): WorkflowResponse<VoidInventoryCountWorkflowOutput> {
    const reversed = contraApplyStockStep({
      location_id: input.stock_location_id,
      lines: input.lines_to_reverse,
    });

    const affectedLineIds = transform({ input }, (data) =>
      data.input.lines_to_reverse.map((l) => l.line_id)
    );

    const persisted = persistVoidResultsStep({
      count_id: input.count_id,
      voided_by_user_id: input.voided_by_user_id,
      void_reason: input.void_reason,
      affected_line_ids: affectedLineIds,
      pipeline_rows: input.pipeline_rows_to_void,
    });

    // Mirror approve-inventory-count: a void contra-applies stock, so the
    // MeiliSearch inventory index must be refreshed for every reversed item.
    // (The inventory_level trigger also covers this, but the explicit step
    // gives instant parity instead of waiting for the ~1-min queue pass.)
    const meiliInput = transform({ reversed }, (data) => ({
      inventory_item_ids: Array.from(
        new Set(data.reversed.reversed.map((r) => r.inventory_item_id))
      ),
    }));

    syncReceiptInventoryMeiliStep(meiliInput);

    const response = transform({ input, reversed, persisted }, (data) => ({
      count_id: data.input.count_id,
      reversed_count: data.reversed.reversed.length,
      voided_line_count: data.persisted.voided_line_count,
      pipeline_void_queued: data.persisted.pipeline_void_queued,
    }));

    return new WorkflowResponse(response);
  }
);

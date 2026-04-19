/**
 * src/workflows/inventory-count/steps/persist-void-results-step.ts
 *
 * Marks the inventory_count as 'voided' (with audit fields), transitions
 * the formerly-applied lines to status='voided', and flags every related
 * qb_inventory_adjustment_pipeline row for the QB void send phase.
 */

import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk";

import { INVENTORY_COUNT_MODULE } from "../../../modules/inventory-count";
import type InventoryCountModuleService from "../../../modules/inventory-count/service";

export interface PersistVoidResultsStepInput {
  count_id: string;
  voided_by_user_id: string;
  void_reason: string;
  affected_line_ids: string[];
  pipeline_row_ids: string[]; // pipeline rows already synced to QB that need voiding
}

export interface PersistVoidResultsStepOutput {
  voided_line_count: number;
  pipeline_void_queued: number;
}

export const persistVoidResultsStep = createStep(
  "persist-inventory-count-void-results",
  async (
    input: PersistVoidResultsStepInput,
    { container }
  ): Promise<StepResponse<PersistVoidResultsStepOutput, null>> => {
    const service = container.resolve(
      INVENTORY_COUNT_MODULE
    ) as unknown as InventoryCountModuleService;

    // 1. Update the header
    await service.updateInventoryCounts([
      {
        id: input.count_id,
        status: "voided",
        voided_at: new Date(),
        voided_by_user_id: input.voided_by_user_id,
        void_reason: input.void_reason,
      },
    ]);

    // 2. Transition lines: only the ones that actually moved stock
    if (input.affected_line_ids.length > 0) {
      await service.updateInventoryCountLines(
        input.affected_line_ids.map((id) => ({ id, status: "voided" }))
      );
    }

    // 3. Flag pipeline rows for QB void
    if (input.pipeline_row_ids.length > 0) {
      await service.updateQbInventoryAdjustmentPipelines(
        input.pipeline_row_ids.map((id) => ({
          id,
          void_status: "waiting",
          void_retries: 0,
          void_last_error: null,
          void_next_retry_at: null,
        }))
      );
    }

    return new StepResponse(
      {
        voided_line_count: input.affected_line_ids.length,
        pipeline_void_queued: input.pipeline_row_ids.length,
      },
      null
    );
  }
);

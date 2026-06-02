/**
 * src/workflows/inventory-count/steps/persist-void-results-step.ts
 *
 * Marks the inventory_count as 'voided' (with audit fields), transitions
 * the formerly-applied lines to status='voided', and inserts a
 * 'void_inventory_adjustment' row into qb_order_pipeline for every
 * inventory_adjustment row that was already confirmed in QB.
 * The consolidator/resubmit-by-step picks these up and sends TxnVoidRq.
 */

import { randomUUID } from "crypto";
import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk";

import { getDbPool } from "../../../api/utils/db-pool";
import { INVENTORY_COUNT_MODULE } from "../../../modules/inventory-count";
import type InventoryCountModuleService from "../../../modules/inventory-count/service";

export interface PipelineRowToVoid {
  /** id of the confirmed qb_order_pipeline inventory_adjustment row */
  id: string;
  /** QB TxnID needed by voidInventoryAdjustmentInQb */
  qb_txn_id: string;
}

export interface PersistVoidResultsStepInput {
  count_id: string;
  voided_by_user_id: string;
  void_reason: string;
  affected_line_ids: string[];
  pipeline_rows: PipelineRowToVoid[]; // pipeline rows already confirmed in QB
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

    // 3. Insert void_inventory_adjustment rows into qb_order_pipeline for every
    // confirmed inventory_adjustment row. The consolidator/resubmit-by-step
    // picks these up and sends TxnVoidRq to QB Desktop.
    let pipeline_void_queued = 0;
    if (input.pipeline_rows.length > 0) {
      const pool = getDbPool();
      for (const src of input.pipeline_rows) {
        const refId = `${src.id}:void`;
        // Idempotent: skip if a void row already exists for this source row
        const { rows: existing } = await pool.query(
          `SELECT id FROM qb_order_pipeline WHERE reference_id = $1 AND step = 'void_inventory_adjustment' LIMIT 1`,
          [refId]
        );
        if (existing.length > 0) continue;

        await pool.query(
          `INSERT INTO qb_order_pipeline
             (id, order_id, reference_id, reference_type, step, status, qb_txn_id, created_at, updated_at)
           VALUES ($1, $2, $3, 'inventory_count', 'void_inventory_adjustment', 'pending', $4, NOW(), NOW())`,
          [randomUUID(), input.count_id, refId, src.qb_txn_id]
        );
        pipeline_void_queued++;
      }
    }

    return new StepResponse(
      {
        voided_line_count: input.affected_line_ids.length,
        pipeline_void_queued,
      },
      null
    );
  }
);

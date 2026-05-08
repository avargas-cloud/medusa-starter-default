/**
 * src/workflows/inventory-count/steps/enqueue-qb-adjustments-step.ts
 *
 * Groups applied lines by qb_account_list_id and inserts one row per group
 * into qb_order_pipeline (step='inventory_adjustment'). The consolidator
 * cron picks these up and calls the QB bridge — same path as every other
 * QB operation. No separate poller.
 *
 * reference_id = "${count_id}:${accountListId}" — unique per group, idempotent.
 * order_id     = count_id — lets poll-submitted-rows stamp qb_synced_at on confirm.
 *
 * No compensation: if this step fails, no QB queue rows exist yet, so
 * there is nothing to revert (Medusa stock changes are reverted by the
 * apply-stock-deltas-step compensation).
 */

import { randomUUID } from "crypto";
import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk";
import { getDbPool } from "../../../api/utils/db-pool";

import type { AppliedDelta } from "./apply-stock-deltas-step";
import type { ClassifiedLine } from "./classify-lines-step";

export interface EnqueueQbAdjustmentsStepInput {
  count_id: string;
  count_number: string;
  count_memo: string;
  toApply: ClassifiedLine[];
  applied: AppliedDelta[];
}

export interface EnqueueQbAdjustmentsStepOutput {
  pipeline_ids: string[];
  groups: Array<{
    qb_account_list_id: string;
    line_count: number;
    pipeline_id: string;
  }>;
}

export const enqueueQbAdjustmentsStep = createStep(
  "enqueue-qb-inventory-adjustments",
  async (
    input: EnqueueQbAdjustmentsStepInput
  ): Promise<StepResponse<EnqueueQbAdjustmentsStepOutput, null>> => {
    if (input.applied.length === 0) {
      return new StepResponse({ pipeline_ids: [], groups: [] }, null);
    }

    const pool = getDbPool();

    const appliedByLineId = new Map<string, AppliedDelta>();
    for (const a of input.applied) appliedByLineId.set(a.line_id, a);

    const groupsByAccount = new Map<string, ClassifiedLine[]>();
    for (const line of input.toApply) {
      const list = groupsByAccount.get(line.qb_account_list_id) ?? [];
      list.push(line);
      groupsByAccount.set(line.qb_account_list_id, list);
    }

    const groupSummary: EnqueueQbAdjustmentsStepOutput["groups"] = [];
    const pipelineIds: string[] = [];

    for (const [accountListId, lines] of groupsByAccount.entries()) {
      const payload = {
        count_id: input.count_id,
        count_number: input.count_number,
        count_memo: input.count_memo,
        qb_account_list_id: accountListId,
        lines: lines.map((l) => {
          const a = appliedByLineId.get(l.line_id);
          return {
            line_id: l.line_id,
            inventory_item_id: l.inventory_item_id,
            product_variant_id: l.product_variant_id,
            sku: l.sku,
            delta_applied: a?.delta_applied ?? l.effective_delta,
            new_stock: a?.new_stock ?? l.projected_stock,
          };
        }),
      };

      // Composite reference_id is unique per group and idempotent across retries.
      const referenceId = `${input.count_id}:${accountListId}`;
      const id = randomUUID();

      // Upsert: if a pending/failed row already exists for this group (e.g. manual
      // retry), reset it to pending with a fresh payload. Otherwise INSERT new.
      const { rows: updated } = await pool.query(
        `UPDATE qb_order_pipeline
            SET status = 'pending', payload = $2::jsonb, error = NULL,
                next_retry_at = NULL, updated_at = NOW()
          WHERE reference_id = $1 AND step = 'inventory_adjustment'
            AND status IN ('pending', 'failed')
          RETURNING id`,
        [referenceId, JSON.stringify(payload)]
      );

      let rowId: string;
      if (updated.length > 0) {
        rowId = updated[0].id as string;
      } else {
        await pool.query(
          `INSERT INTO qb_order_pipeline
             (id, order_id, reference_id, reference_type, step, status, payload,
              medusa_ref_number, created_at, updated_at)
           VALUES ($1, $2, $3, 'inventory_count', 'inventory_adjustment', 'pending',
                   $4::jsonb, $5, NOW(), NOW())`,
          [id, input.count_id, referenceId, JSON.stringify(payload), input.count_number]
        );
        rowId = id;
      }

      pipelineIds.push(rowId);
      groupSummary.push({
        qb_account_list_id: accountListId,
        line_count: lines.length,
        pipeline_id: rowId,
      });
    }

    return new StepResponse({ pipeline_ids: pipelineIds, groups: groupSummary }, null);
  }
);

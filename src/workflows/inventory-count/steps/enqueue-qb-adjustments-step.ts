/**
 * src/workflows/inventory-count/steps/enqueue-qb-adjustments-step.ts
 *
 * Groups applied lines by qb_account_list_id and inserts one row per group
 * into qb_inventory_adjustment_pipeline. Each row contains an immutable
 * payload snapshot used by the cron poller; future retries read the
 * payload, never the live tables.
 *
 * No compensation: if this step fails, no QB queue rows exist yet, so
 * there is nothing to revert (Medusa stock changes are reverted by the
 * apply-stock-deltas-step compensation).
 */

import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk";

import { INVENTORY_COUNT_MODULE } from "../../../modules/inventory-count";
import type InventoryCountModuleService from "../../../modules/inventory-count/service";

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

interface GroupPayloadLine {
  line_id: string;
  inventory_item_id: string;
  product_variant_id: string;
  sku: string;
  delta_applied: number;
  new_stock: number;
}

interface GroupPayload {
  count_id: string;
  count_number: string;
  count_memo: string;
  qb_account_list_id: string;
  lines: GroupPayloadLine[];
}

export const enqueueQbAdjustmentsStep = createStep(
  "enqueue-qb-inventory-adjustments",
  async (
    input: EnqueueQbAdjustmentsStepInput,
    { container }
  ): Promise<StepResponse<EnqueueQbAdjustmentsStepOutput, null>> => {
    if (input.applied.length === 0) {
      return new StepResponse({ pipeline_ids: [], groups: [] }, null);
    }

    const service = container.resolve(
      INVENTORY_COUNT_MODULE
    ) as unknown as InventoryCountModuleService;

    const appliedByLineId = new Map<string, AppliedDelta>();
    for (const a of input.applied) appliedByLineId.set(a.line_id, a);

    const groupsByAccount = new Map<string, ClassifiedLine[]>();
    for (const line of input.toApply) {
      const list = groupsByAccount.get(line.qb_account_list_id) ?? [];
      list.push(line);
      groupsByAccount.set(line.qb_account_list_id, list);
    }

    const toCreate: Array<Record<string, unknown>> = [];
    const groupSummary: EnqueueQbAdjustmentsStepOutput["groups"] = [];

    for (const [accountListId, lines] of groupsByAccount.entries()) {
      const payload: GroupPayload = {
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

      toCreate.push({
        inventory_count_id: input.count_id,
        qb_account_list_id: accountListId,
        status: "waiting",
        payload,
      });
    }

    const created =
      await service.createQbInventoryAdjustmentPipelines(toCreate);
    const createdArr = Array.isArray(created) ? created : [created];

    for (let i = 0; i < createdArr.length; i++) {
      const row = createdArr[i] as { id: string; qb_account_list_id: string };
      const lineCount =
        groupsByAccount.get(row.qb_account_list_id)?.length ?? 0;
      groupSummary.push({
        qb_account_list_id: row.qb_account_list_id,
        line_count: lineCount,
        pipeline_id: row.id,
      });
    }

    return new StepResponse(
      {
        pipeline_ids: createdArr.map((r) => (r as { id: string }).id),
        groups: groupSummary,
      },
      null
    );
  }
);

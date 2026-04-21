/**
 * src/workflows/purchase-orders/steps/allocate-po-sequence-step.ts
 *
 * Wraps `purchaseOrdersService.getNextPoSequence()` so the submit workflow
 * can compose the human-readable PO number as `PO-{seq}`. No compensation —
 * the Postgres sequence is advisory and gaps are acceptable (same convention
 * used for custom_estimate_seq / custom_inventory_count_seq).
 */

import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk";

import { PURCHASE_ORDERS_MODULE } from "../../../modules/purchase-orders";
import type PurchaseOrdersModuleService from "../../../modules/purchase-orders/service";

export interface AllocatePoSequenceStepOutput {
  seq: number;
  number: string;
}

export const allocatePoSequenceStep = createStep(
  "allocate-po-sequence",
  async (
    _input: Record<string, never>,
    { container }
  ): Promise<StepResponse<AllocatePoSequenceStepOutput, null>> => {
    const service = container.resolve(
      PURCHASE_ORDERS_MODULE
    ) as unknown as PurchaseOrdersModuleService;

    const seq = await service.getNextPoSequence();

    return new StepResponse({ seq, number: `PO-${seq}` }, null);
  }
);

/**
 * src/workflows/purchase-orders/steps/allocate-receipt-sequence-step.ts
 *
 * Wraps `purchaseOrdersService.getNextReceiptSequence()` so the receive
 * workflow can compose the human-readable receipt number as `RCP-{seq}`.
 * No compensation — Postgres sequence gaps are acceptable.
 */

import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk";

import { PURCHASE_ORDERS_MODULE } from "../../../modules/purchase-orders";
import type PurchaseOrdersModuleService from "../../../modules/purchase-orders/service";

export interface AllocateReceiptSequenceStepOutput {
  seq: number;
  number: string;
}

export const allocateReceiptSequenceStep = createStep(
  "allocate-po-receipt-sequence",
  async (
    _input: Record<string, never>,
    { container }
  ): Promise<StepResponse<AllocateReceiptSequenceStepOutput, null>> => {
    const service = container.resolve(
      PURCHASE_ORDERS_MODULE
    ) as unknown as PurchaseOrdersModuleService;

    const seq = await service.getNextReceiptSequence();

    return new StepResponse({ seq, number: `RCP-${seq}` }, null);
  }
);

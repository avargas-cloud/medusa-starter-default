/**
 * src/workflows/purchase-orders/steps/allocate-po-sequence-step.ts
 *
 * Resolves the canonical PO number for the submit workflow. POs are now numbered
 * at creation time (POST /admin/purchase-orders), so this step first reads the
 * existing seq/number from the PO and only falls back to allocating a new one
 * for legacy drafts that predate the change. Gaps are acceptable — same
 * convention as custom_estimate_seq / custom_inventory_count_seq.
 */

import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk";

import { PURCHASE_ORDERS_MODULE } from "../../../modules/purchase-orders";
import type PurchaseOrdersModuleService from "../../../modules/purchase-orders/service";

export interface AllocatePoSequenceStepInput {
  po_id: string;
}

export interface AllocatePoSequenceStepOutput {
  seq: number;
  number: string;
}

export const allocatePoSequenceStep = createStep(
  "allocate-po-sequence",
  async (
    input: AllocatePoSequenceStepInput,
    { container }
  ): Promise<StepResponse<AllocatePoSequenceStepOutput, null>> => {
    const service = container.resolve(
      PURCHASE_ORDERS_MODULE
    ) as unknown as PurchaseOrdersModuleService;

    const existing = (await service.retrievePurchaseOrder(input.po_id)) as {
      seq?: number | null;
      number?: string | null;
    } | null;

    // Idempotent: if the PO already has a real PO-{n} number, return it as-is.
    // D-{n} draft labels do NOT count — they must be replaced with a real number.
    if (
      existing &&
      existing.seq != null &&
      existing.number?.startsWith("PO-")
    ) {
      return new StepResponse(
        { seq: existing.seq, number: existing.number },
        null
      );
    }

    const seq = await service.getNextPoSequence();
    return new StepResponse({ seq, number: `PO-${seq}` }, null);
  }
);

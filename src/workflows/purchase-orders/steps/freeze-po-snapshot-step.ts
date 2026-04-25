/**
 * src/workflows/purchase-orders/steps/freeze-po-snapshot-step.ts
 *
 * Persists the submit-time snapshot to the PurchaseOrder header:
 *   - PO number + seq
 *   - vendor_name_snapshot + vendor_qb_list_id_snapshot
 *   - status='submitted'
 *   - submitted_at + submitted_by_user_id
 *
 * No compensation — the service update is safe to attempt again if downstream
 * steps fail, and nothing downstream mutates this row until the QB sync worker
 * picks up the pipeline entry asynchronously.
 */

import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk";

import { PURCHASE_ORDERS_MODULE } from "../../../modules/purchase-orders";
import type PurchaseOrdersModuleService from "../../../modules/purchase-orders/service";

export interface FreezePoSnapshotStepInput {
  po_id: string;
  seq: number;
  number: string;
  submitted_by_user_id: string;
  vendor_name: string;
  vendor_qb_list_id: string | null;
}

export interface FreezePoSnapshotStepOutput {
  po_id: string;
  number: string;
  submitted_at: Date;
}

export const freezePoSnapshotStep = createStep(
  "freeze-po-snapshot",
  async (
    input: FreezePoSnapshotStepInput,
    { container }
  ): Promise<StepResponse<FreezePoSnapshotStepOutput, null>> => {
    const service = container.resolve(
      PURCHASE_ORDERS_MODULE
    ) as unknown as PurchaseOrdersModuleService;

    const submittedAt = new Date();

    await service.updatePurchaseOrders([
      {
        id: input.po_id,
        seq: input.seq,
        number: input.number,
        status: "submitted",
        vendor_name_snapshot: input.vendor_name,
        vendor_qb_list_id_snapshot: input.vendor_qb_list_id,
        submitted_at: submittedAt,
        submitted_by_user_id: input.submitted_by_user_id,
      },
    ]);

    return new StepResponse(
      {
        po_id: input.po_id,
        number: input.number,
        submitted_at: submittedAt,
      },
      null
    );
  }
);

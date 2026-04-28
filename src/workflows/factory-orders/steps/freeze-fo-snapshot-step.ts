import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk";

import { FACTORY_ORDERS_MODULE } from "../../../modules/factory-orders";
import type FactoryOrdersModuleService from "../../../modules/factory-orders/service";

export interface FreezeFoSnapshotStepInput {
  fo_id: string;
  seq: number;
  number: string;
  submitted_by_user_id: string;
  vendor_name: string;
  vendor_list_id: string | null;
}

export interface FreezeFoSnapshotStepOutput {
  fo_id: string;
  number: string;
  submitted_at: Date;
}

export const freezeFoSnapshotStep = createStep(
  "freeze-fo-snapshot",
  async (
    input: FreezeFoSnapshotStepInput,
    { container }
  ): Promise<StepResponse<FreezeFoSnapshotStepOutput, null>> => {
    const service = container.resolve(
      FACTORY_ORDERS_MODULE
    ) as unknown as FactoryOrdersModuleService;

    const submittedAt = new Date();

    await service.updateFactoryOrders([
      {
        id: input.fo_id,
        seq: input.seq,
        number: input.number,
        status: "submitted",
        vendor_name_snapshot: input.vendor_name,
        vendor_list_id_snapshot: input.vendor_list_id,
        submitted_at: submittedAt,
        submitted_by_user_id: input.submitted_by_user_id,
      },
    ]);

    return new StepResponse(
      {
        fo_id: input.fo_id,
        number: input.number,
        submitted_at: submittedAt,
      },
      null
    );
  }
);

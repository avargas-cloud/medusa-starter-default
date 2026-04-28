import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk";

import { FACTORY_ORDERS_MODULE } from "../../../modules/factory-orders";
import type FactoryOrdersModuleService from "../../../modules/factory-orders/service";

export interface AllocateFoSequenceStepInput {
  fo_id: string;
}

export interface AllocateFoSequenceStepOutput {
  seq: number;
  number: string;
}

export const allocateFoSequenceStep = createStep(
  "allocate-fo-sequence",
  async (
    input: AllocateFoSequenceStepInput,
    { container }
  ): Promise<StepResponse<AllocateFoSequenceStepOutput, null>> => {
    const service = container.resolve(
      FACTORY_ORDERS_MODULE
    ) as unknown as FactoryOrdersModuleService;

    const existing = (await service.retrieveFactoryOrder(input.fo_id)) as {
      seq?: number | null;
      number?: string | null;
    } | null;

    // Idempotent: if already has a real FO-{n} number, return as-is.
    if (
      existing &&
      existing.seq != null &&
      existing.number?.startsWith("FO-")
    ) {
      return new StepResponse(
        { seq: existing.seq, number: existing.number },
        null
      );
    }

    const seq = await service.getNextFoSequence();
    return new StepResponse({ seq, number: `FO-${seq}` }, null);
  }
);

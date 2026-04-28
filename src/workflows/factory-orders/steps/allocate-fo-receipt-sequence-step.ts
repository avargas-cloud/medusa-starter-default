import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk";

import { FACTORY_ORDERS_MODULE } from "../../../modules/factory-orders";
import type FactoryOrdersModuleService from "../../../modules/factory-orders/service";

export interface AllocateFoReceiptSequenceStepOutput {
  seq: number;
  number: string;
}

export const allocateFoReceiptSequenceStep = createStep(
  "allocate-fo-receipt-sequence",
  async (
    _input: Record<string, never>,
    { container }
  ): Promise<StepResponse<AllocateFoReceiptSequenceStepOutput, null>> => {
    const service = container.resolve(
      FACTORY_ORDERS_MODULE
    ) as unknown as FactoryOrdersModuleService;

    const seq = await service.getNextReceiptSequence();
    return new StepResponse({ seq, number: `FRCP-${seq}` }, null);
  }
);

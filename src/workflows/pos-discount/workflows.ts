import { createWorkflow, WorkflowResponse } from "@medusajs/framework/workflows-sdk"
import { overrideOrderChangeAdjustmentsStep } from "./steps"

type PosOverrideAdjustmentsInput = {
    order_id: string
    promotion_code?: string
    pct_discount?: number | null
}

export const posOverrideAdjustmentsWorkflow = createWorkflow(
    "pos-override-adjustments",
    (input: PosOverrideAdjustmentsInput) => {
        const orderChange = overrideOrderChangeAdjustmentsStep(input)
        return new WorkflowResponse(orderChange)
    }
)

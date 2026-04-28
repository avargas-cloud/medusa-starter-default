/**
 * Transitions a FactoryOrder from `draft` to `submitted`:
 *   1. validateFoForSubmitStep  — verifies status + lines have required fields
 *   2. allocateFoSequenceStep   — reserves FO-{seq}
 *   3. freezeFoSnapshotStep     — persists number + vendor snapshot + status
 *
 * No QB enqueue step — factory orders are Medusa-only.
 */

import {
  createWorkflow,
  transform,
  WorkflowResponse,
} from "@medusajs/framework/workflows-sdk";

import { allocateFoSequenceStep } from "./steps/allocate-fo-sequence-step";
import { freezeFoSnapshotStep } from "./steps/freeze-fo-snapshot-step";
import { validateFoForSubmitStep } from "./steps/validate-fo-for-submit-step";

export interface SubmitFactoryOrderWorkflowInput {
  fo_id: string;
  submitted_by_user_id: string;
}

export interface SubmitFactoryOrderWorkflowOutput {
  fo_id: string;
  number: string;
  status: "submitted";
  submitted_at: Date;
}

export const submitFactoryOrderWorkflow = createWorkflow(
  "submit-factory-order",
  function (
    input: SubmitFactoryOrderWorkflowInput
  ): WorkflowResponse<SubmitFactoryOrderWorkflowOutput> {
    const validated = validateFoForSubmitStep({ fo_id: input.fo_id });

    const seq = allocateFoSequenceStep({ fo_id: input.fo_id });

    const snapshotInput = transform({ input, validated, seq }, (data) => ({
      fo_id: data.input.fo_id,
      seq: data.seq.seq,
      number: data.seq.number,
      submitted_by_user_id: data.input.submitted_by_user_id,
      vendor_name: data.validated.vendor.vendor_name,
      vendor_list_id: data.validated.vendor.vendor_list_id,
    }));

    const frozen = freezeFoSnapshotStep(snapshotInput);

    const response = transform({ input, frozen }, (data) => ({
      fo_id: data.input.fo_id,
      number: data.frozen.number,
      status: "submitted" as const,
      submitted_at: data.frozen.submitted_at,
    }));

    return new WorkflowResponse(response);
  }
);

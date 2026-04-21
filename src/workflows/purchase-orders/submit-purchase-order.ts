/**
 * src/workflows/purchase-orders/submit-purchase-order.ts
 *
 * Transitions a PurchaseOrder from `draft` to `submitted`:
 *   1. validatePoForSubmitStep      — verifies vendor + all lines have QB refs
 *   2. allocatePoSequenceStep       — reserves PO-{seq}
 *   3. freezePoSnapshotStep         — persists number + vendor snapshots + status
 *   4. enqueueQbPurchaseOrderStep   — frozen JSON row in qb_purchase_order_pipeline
 *
 * The route handler is responsible for:
 *   - verifying admin role (not pos_user)
 *   - loading the draft PO context for the error surface
 *
 * Stock is NOT touched here — a submitted PO is a commercial commitment,
 * not a physical movement. Stock adjusts only at receipt time.
 */

import {
  createWorkflow,
  transform,
  WorkflowResponse,
} from "@medusajs/framework/workflows-sdk";

import { allocatePoSequenceStep } from "./steps/allocate-po-sequence-step";
import { enqueueQbPurchaseOrderStep } from "./steps/enqueue-qb-purchase-order-step";
import { freezePoSnapshotStep } from "./steps/freeze-po-snapshot-step";
import { validatePoForSubmitStep } from "./steps/validate-po-for-submit-step";

export interface SubmitPurchaseOrderWorkflowInput {
  po_id: string;
  submitted_by_user_id: string;
}

export interface SubmitPurchaseOrderWorkflowOutput {
  po_id: string;
  number: string;
  status: "submitted";
  qb_pipeline_id: string;
  submitted_at: Date;
}

export const submitPurchaseOrderWorkflow = createWorkflow(
  "submit-purchase-order",
  function (
    input: SubmitPurchaseOrderWorkflowInput
  ): WorkflowResponse<SubmitPurchaseOrderWorkflowOutput> {
    const validated = validatePoForSubmitStep({ po_id: input.po_id });

    const seq = allocatePoSequenceStep({});

    const snapshotInput = transform(
      { input, validated, seq },
      (data) => ({
        po_id: data.input.po_id,
        seq: data.seq.seq,
        number: data.seq.number,
        submitted_by_user_id: data.input.submitted_by_user_id,
        vendor_name: data.validated.vendor.vendor_name,
        vendor_qb_list_id: data.validated.vendor.vendor_qb_list_id,
      })
    );

    const frozen = freezePoSnapshotStep(snapshotInput);

    const enqueueInput = transform(
      { input, validated, frozen },
      (data) => ({
        po_id: data.input.po_id,
        po_number: data.frozen.number,
        vendor_qb_list_id: data.validated.vendor.vendor_qb_list_id,
        vendor_name: data.validated.vendor.vendor_name,
        ordered_at: data.validated.po.ordered_at,
        expected_at: data.validated.po.expected_at,
        memo: data.validated.po.memo,
        reference_number: data.validated.po.reference_number,
        lines: data.validated.lines.map((l) => ({
          line_id: l.line_id,
          qb_item_list_id: l.qb_item_list_id,
          sku: l.sku,
          description: l.description,
          qty_ordered: l.qty_ordered,
          unit_cost_cents: l.unit_cost_cents,
        })),
      })
    );

    const queued = enqueueQbPurchaseOrderStep(enqueueInput);

    const response = transform(
      { input, frozen, queued },
      (data) => ({
        po_id: data.input.po_id,
        number: data.frozen.number,
        status: "submitted" as const,
        qb_pipeline_id: data.queued.pipeline_id,
        submitted_at: data.frozen.submitted_at,
      })
    );

    return new WorkflowResponse(response);
  }
);

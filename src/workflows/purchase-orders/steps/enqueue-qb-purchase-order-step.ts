/**
 * src/workflows/purchase-orders/steps/enqueue-qb-purchase-order-step.ts
 *
 * Inserts a frozen-payload row into qb_purchase_order_pipeline with
 * status='waiting'. The cron poller picks it up asynchronously, builds the
 * QBXML PurchaseOrderAddRq, and transitions status waiting→processing→synced
 * (or error with next_retry_at).
 *
 * payload is a self-contained JSON snapshot that retries can rehydrate
 * from without touching the live tables. Format is tightly coupled to the
 * quickbooks-bridge purchaseOrder.ts builder (F4).
 *
 * No compensation: if the insert succeeds but a later step fails, the
 * waiting row is harmless (poller will send it anyway, but the PO header
 * will have been rolled back by upstream compensation — in practice this
 * step is last in the submit workflow, so there is nothing after it).
 */

import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk";

import { PURCHASE_ORDERS_MODULE } from "../../../modules/purchase-orders";
import type PurchaseOrdersModuleService from "../../../modules/purchase-orders/service";

export interface EnqueueQbPurchaseOrderStepInputLine {
  line_id: string;
  qb_item_list_id: string | null;
  sku: string;
  description: string;
  qty_ordered: number;
  unit_cost_cents: number;
}

export interface EnqueueQbPurchaseOrderStepInput {
  po_id: string;
  po_number: string;
  vendor_qb_list_id: string | null;
  vendor_name: string;
  ordered_at: Date | null;
  expected_at: Date | null;
  memo: string | null;
  reference_number: string | null;
  lines: EnqueueQbPurchaseOrderStepInputLine[];
}

export interface EnqueueQbPurchaseOrderStepOutput {
  pipeline_id: string | null;
}

interface QbPoPayload {
  po_id: string;
  po_number: string;
  vendor_qb_list_id: string;
  vendor_name: string;
  ordered_at: string | null;
  expected_at: string | null;
  memo: string | null;
  reference_number: string | null;
  lines: Array<{
    line_id: string;
    qb_item_list_id: string;
    sku: string;
    description: string;
    qty_ordered: number;
    unit_cost_cents: number;
  }>;
}

export const enqueueQbPurchaseOrderStep = createStep(
  "enqueue-qb-purchase-order",
  async (
    input: EnqueueQbPurchaseOrderStepInput,
    { container }
  ): Promise<StepResponse<EnqueueQbPurchaseOrderStepOutput, null>> => {
    const hasAllQbRefs =
      input.vendor_qb_list_id !== null &&
      input.lines.every((l) => l.qb_item_list_id !== null);
    if (!hasAllQbRefs) {
      return new StepResponse({ pipeline_id: null }, null);
    }

    const service = container.resolve(
      PURCHASE_ORDERS_MODULE
    ) as unknown as PurchaseOrdersModuleService;

    const payload: QbPoPayload = {
      po_id: input.po_id,
      po_number: input.po_number,
      vendor_qb_list_id: input.vendor_qb_list_id!,
      vendor_name: input.vendor_name,
      // Defensive: after MikroORM serialization these may arrive as strings
      // rather than Date objects. Normalize both paths.
      ordered_at: input.ordered_at
        ? new Date(input.ordered_at as unknown as string | Date).toISOString()
        : null,
      expected_at: input.expected_at
        ? new Date(input.expected_at as unknown as string | Date).toISOString()
        : null,
      memo: input.memo,
      reference_number: input.reference_number,
      lines: input.lines.map((l) => ({
        line_id: l.line_id,
        qb_item_list_id: l.qb_item_list_id!,
        sku: l.sku,
        description: l.description,
        qty_ordered: l.qty_ordered,
        unit_cost_cents: l.unit_cost_cents,
      })),
    };

    const toCreate: Array<Record<string, unknown>> = [
      {
        purchase_order_id: input.po_id,
        status: "waiting",
        payload,
      },
    ];
    const created = await service.createQbPurchaseOrderPipelines(toCreate);

    const arr = Array.isArray(created) ? created : [created];
    const row = arr[0] as { id: string };

    return new StepResponse({ pipeline_id: row.id }, null);
  }
);

/**
 * src/workflows/purchase-orders/steps/enqueue-qb-item-receipt-step.ts
 *
 * Inserts a frozen-payload row into qb_item_receipt_pipeline with
 * status='waiting'. The cron poller later builds the QBXML ItemReceiptAddRq,
 * which atomically creates an ItemReceipt in QB (increases stock and
 * creates the AP balance against the vendor).
 *
 * payload format is tightly coupled to the quickbooks-bridge itemReceipt.ts
 * builder (F4). Retries always rehydrate from this column.
 */

import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk";

import { PURCHASE_ORDERS_MODULE } from "../../../modules/purchase-orders";
import type PurchaseOrdersModuleService from "../../../modules/purchase-orders/service";
import {
  enqueuePurchaseQbOperation,
  purchaseOperationKey,
} from "../../../lib/purchase-orders/qb-purchase-dependency-chain";
import { qbItemReceiptIdentityMemo } from "../../../lib/purchase-orders/qb-item-receipt-identity";

export interface EnqueueQbItemReceiptStepInputLine {
  receipt_line_id: string;
  po_line_id: string;
  qb_item_list_id: string;
  qb_po_txn_line_id: string | null;
  sku: string;
  description: string;
  qty_received_now: number;
  unit_cost_cents: number; // effective cost: override ?? po_line unit_cost
}

export interface EnqueueQbItemReceiptStepInput {
  po_id: string;
  po_number: string;
  receipt_id: string;
  receipt_number: string;
  vendor_qb_list_id: string;
  vendor_name: string;
  qb_po_list_id: string | null;
  inventory_site_list_id: string | null;
  received_at: Date;
  vendor_bill_number: string | null;
  vendor_bill_date: Date | null;
  memo: string | null;
  lines: EnqueueQbItemReceiptStepInputLine[];
}

export interface EnqueueQbItemReceiptStepOutput {
  pipeline_id: string;
}

interface QbItemReceiptPayload {
  delegated_to_consolidator: true;
  qb_identity_memo: string;
  po_id: string;
  po_number: string;
  receipt_id: string;
  receipt_number: string;
  vendor_qb_list_id: string;
  vendor_name: string;
  qb_po_list_id: string | null;
  inventory_site_list_id: string | null;
  received_at: string;
  vendor_bill_number: string | null;
  vendor_bill_date: string | null;
  memo: string | null;
  lines: Array<{
    receipt_line_id: string;
    po_line_id: string;
    qb_item_list_id: string;
    qb_po_txn_line_id: string | null;
    sku: string;
    description: string;
    qty_received_now: number;
    unit_cost_cents: number;
  }>;
}

export const enqueueQbItemReceiptStep = createStep(
  "enqueue-qb-item-receipt",
  async (
    input: EnqueueQbItemReceiptStepInput,
    { container }
  ): Promise<StepResponse<EnqueueQbItemReceiptStepOutput, null>> => {
    const service = container.resolve(
      PURCHASE_ORDERS_MODULE
    ) as unknown as PurchaseOrdersModuleService;

    const payload: QbItemReceiptPayload = {
      delegated_to_consolidator: true,
      qb_identity_memo: qbItemReceiptIdentityMemo({
        receiptId: input.receipt_id,
        receiptNumber: input.receipt_number,
        memo: input.memo,
      }),
      po_id: input.po_id,
      po_number: input.po_number,
      receipt_id: input.receipt_id,
      receipt_number: input.receipt_number,
      vendor_qb_list_id: input.vendor_qb_list_id,
      vendor_name: input.vendor_name,
      qb_po_list_id: input.qb_po_list_id,
      inventory_site_list_id: input.inventory_site_list_id,
      received_at: new Date(
        input.received_at as unknown as string | Date
      ).toISOString(),
      vendor_bill_number: input.vendor_bill_number,
      vendor_bill_date: input.vendor_bill_date
        ? new Date(
            input.vendor_bill_date as unknown as string | Date
          ).toISOString()
        : null,
      memo: input.memo,
      lines: input.lines.map((l) => ({
        receipt_line_id: l.receipt_line_id,
        po_line_id: l.po_line_id,
        qb_item_list_id: l.qb_item_list_id,
        qb_po_txn_line_id: l.qb_po_txn_line_id,
        sku: l.sku,
        description: l.description,
        qty_received_now: l.qty_received_now,
        unit_cost_cents: l.unit_cost_cents,
      })),
    };

    const toCreate: Array<Record<string, unknown>> = [
      {
        purchase_order_receipt_id: input.receipt_id,
        purchase_order_id: input.po_id,
        status: "waiting",
        payload,
      },
    ];
    const created = await service.createQbItemReceiptPipelines(toCreate);

    const arr = Array.isArray(created) ? created : [created];
    const row = arr[0] as { id: string };
    const knex = container.resolve("__pg_connection__") as {
      raw: (
        sql: string,
        bindings?: unknown[]
      ) => Promise<{ rows: unknown[]; rowCount?: number }>;
    };
    const orderPayload = {
      ...payload,
      qb_item_receipt_pipeline_id: row.id,
    };
    const operation = await enqueuePurchaseQbOperation(knex, {
      purchaseOrderId: input.po_id,
      referenceId: input.receipt_id,
      referenceType: "item_receipt",
      step: "item_receipt_add",
      payload: orderPayload,
      operationKey: purchaseOperationKey(
        "item_receipt_add",
        input.receipt_id,
        orderPayload
      ),
    });
    await knex.raw(
      `UPDATE qb_item_receipt_pipeline
          SET add_order_pipeline_id = ?, updated_at = NOW()
        WHERE id = ?`,
      [operation.id, row.id]
    );

    return new StepResponse({ pipeline_id: row.id }, null);
  }
);

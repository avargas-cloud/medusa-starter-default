/**
 * src/workflows/purchase-orders/steps/persist-delete-receipt-step.ts
 *
 * Hard-delete persistence for a PurchaseOrderReceipt. Mirrors
 * persistVoidReceiptStep but ends in actual row deletion (FK CASCADE wipes
 * receipt lines, vendor_bill, qb_item_receipt_pipeline) instead of leaving
 * a 'voided' tombstone.
 *
 * Two delete paths:
 *
 *   Path A — receipt was never QB-synced (qb_item_receipt_list_id IS NULL):
 *     contra-stock + decrement qty_received + recompute PO status +
 *     deletePurchaseOrderReceipts([id]) — fully synchronous, atomic.
 *
 *   Path B — receipt is QB-synced (qb_item_receipt_list_id IS NOT NULL):
 *     contra-stock + decrement qty_received + recompute PO status, then mark
 *     receipt status='deleted' (text, not enum — no migration needed) and
 *     ensure qb_item_receipt_pipeline.void_status='waiting'. The existing
 *     qb-item-receipt-poller fires DELETE /api/item-receipts/:txnId to the
 *     QB Desktop bridge; on success it sees status='deleted' and hard-deletes
 *     the receipt (cascade wipes lines + pipeline).
 *
 * "Already voided" branch: when called with was_already_voided=true the
 * stock + qty_received recompute is skipped (those mutations happened at
 * void time). We only finish the deletion: Path A if QB list_id is null
 * (or already cleared by a prior synced void), else Path B.
 */

import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk";

import { PURCHASE_ORDERS_MODULE } from "../../../modules/purchase-orders";
import type PurchaseOrdersModuleService from "../../../modules/purchase-orders/service";

import type { ReceiptReversedDelta } from "./contra-apply-receipt-stock-step";

export interface PersistDeleteReceiptStepInput {
  receipt_id: string;
  po_id: string;
  deleted_by_user_id: string;
  delete_reason: string;
  reversed: ReceiptReversedDelta[];
  was_already_voided: boolean;
}

export interface PersistDeleteReceiptStepOutput {
  receipt_id: string;
  hard_deleted: boolean;
  qb_delete_queued: boolean;
  po_status_after: "submitted" | "partially_received" | "received";
  total_units_received: number;
}

interface ReceiptHeaderRow {
  id: string;
  status: string;
  qb_item_receipt_list_id: string | null;
}

export const persistDeleteReceiptStep = createStep(
  "persist-po-receipt-delete-results",
  async (
    input: PersistDeleteReceiptStepInput,
    { container }
  ): Promise<StepResponse<PersistDeleteReceiptStepOutput, null>> => {
    const service = container.resolve(
      PURCHASE_ORDERS_MODULE
    ) as unknown as PurchaseOrdersModuleService;

    const receipt = (await service.retrievePurchaseOrderReceipt(
      input.receipt_id
    )) as unknown as ReceiptHeaderRow;
    const isQbSynced = !!receipt.qb_item_receipt_list_id;

    let totalReceivedAfter = 0;
    let newPoStatus: "submitted" | "partially_received" | "received" =
      "submitted";

    if (!input.was_already_voided) {
      // Recompute affected PurchaseOrderLine counters from the reversed deltas
      const voidedByPoLineId = new Map<string, number>();
      for (const r of input.reversed) {
        const prev = voidedByPoLineId.get(r.po_line_id) ?? 0;
        voidedByPoLineId.set(r.po_line_id, prev + Math.abs(r.reversed_qty));
      }

      const poLines = (await service.listPurchaseOrderLines(
        { purchase_order_id: input.po_id },
        { take: 1000 }
      )) as unknown as Array<{
        id: string;
        qty_ordered: number;
        qty_received: number;
      }>;

      const lineUpdates: Array<Record<string, unknown>> = [];
      let totalOrdered = 0;

      for (const pol of poLines) {
        const voidedQty = voidedByPoLineId.get(pol.id) ?? 0;
        const newReceived = Math.max(0, pol.qty_received - voidedQty);
        const newStatus =
          newReceived === 0
            ? "open"
            : newReceived < pol.qty_ordered
              ? "partial"
              : "complete";

        if (voidedQty > 0) {
          lineUpdates.push({
            id: pol.id,
            qty_received: newReceived,
            status: newStatus,
          });
        }
        totalOrdered += pol.qty_ordered;
        totalReceivedAfter += newReceived;
      }

      if (lineUpdates.length > 0) {
        await service.updatePurchaseOrderLines(lineUpdates);
      }

      newPoStatus =
        totalReceivedAfter === 0
          ? "submitted"
          : totalReceivedAfter >= totalOrdered
            ? "received"
            : "partially_received";

      await service.updatePurchaseOrders([
        {
          id: input.po_id,
          status: newPoStatus,
          total_units_received: totalReceivedAfter,
        },
      ]);
    } else {
      // Already voided: PO header counters are already correct. Just read them
      // back so the response is accurate.
      const po = (await service.retrievePurchaseOrder(
        input.po_id
      )) as unknown as {
        status: "submitted" | "partially_received" | "received";
        total_units_received: number;
      };
      newPoStatus = po.status;
      totalReceivedAfter = po.total_units_received;
    }

    if (!isQbSynced) {
      // Path A — never synced (or already QB-deleted via prior void). Safe to
      // hard-delete now; CASCADE wipes lines + pipeline + vendor_bill.
      await service.deletePurchaseOrderReceipts([input.receipt_id]);

      return new StepResponse(
        {
          receipt_id: input.receipt_id,
          hard_deleted: true,
          qb_delete_queued: false,
          po_status_after: newPoStatus,
          total_units_received: totalReceivedAfter,
        },
        null
      );
    }

    // Path B — QB-synced. Tombstone the receipt + ensure pipeline void is
    // queued so the poller fires DELETE /api/item-receipts/:txnId. The poller
    // does the final hard-delete when QB confirms.
    const now = new Date();
    await service.updatePurchaseOrderReceipts([
      {
        id: input.receipt_id,
        status: "deleted",
        voided_at: now,
        voided_by_user_id: input.deleted_by_user_id,
        void_reason: input.delete_reason,
      },
    ]);

    if (input.reversed.length > 0 && !input.was_already_voided) {
      // Mirror persist-void: clear stock_applied flags so audit reflects the
      // reversal even though the rows are about to vanish.
      await service.updatePurchaseOrderReceiptLines(
        input.reversed.map((r) => ({
          id: r.receipt_line_id,
          stock_applied: false,
          stock_applied_at: null,
        }))
      );
    }

    const pipelineRows = (await service.listQbItemReceiptPipelines(
      { purchase_order_receipt_id: input.receipt_id },
      { take: 10 }
    )) as unknown as Array<{
      id: string;
      status: string;
      void_status: string | null;
      qb_list_id: string | null;
    }>;

    let qbDeleteQueued = false;
    const pipelineUpdates: Array<Record<string, unknown>> = [];
    for (const p of pipelineRows) {
      if (!p.qb_list_id) continue; // shouldn't happen since isQbSynced=true
      if (p.void_status === "synced") continue; // already QB-deleted
      pipelineUpdates.push({
        id: p.id,
        void_status: "waiting",
        void_retries: 0,
        void_last_error: null,
        void_next_retry_at: null,
      });
      qbDeleteQueued = true;
    }
    if (pipelineUpdates.length > 0) {
      await service.updateQbItemReceiptPipelines(pipelineUpdates);
    }

    return new StepResponse(
      {
        receipt_id: input.receipt_id,
        hard_deleted: false,
        qb_delete_queued: qbDeleteQueued,
        po_status_after: newPoStatus,
        total_units_received: totalReceivedAfter,
      },
      null
    );
  }
);

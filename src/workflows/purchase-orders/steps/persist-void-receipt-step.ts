/**
 * src/workflows/purchase-orders/steps/persist-void-receipt-step.ts
 *
 * Marks a PurchaseOrderReceipt as voided, audits the void metadata,
 * resets stock_applied on the affected receipt lines, recomputes per-line
 * qty_received on the affected PurchaseOrderLines, updates the PO header
 * counters + status, and flags the corresponding qb_item_receipt_pipeline
 * row for QB void sync (void_status='waiting').
 *
 * Status recomputation after void:
 *   - po_line: qty_received -= sum(voided receipt_line qty_received_now)
 *     → status: 0 → 'open', 0<qty<ordered → 'partial', qty>=ordered → 'complete'
 *   - po header: total_units_received -= total voided qty
 *     → status: 0 → 'submitted', 0<total<ordered → 'partially_received',
 *              total>=ordered → 'received'
 *     (voided PO header status is NOT set here — a receipt void does not
 *      void the entire PO; the admin must explicitly void the PO itself
 *      in a separate workflow.)
 *
 * Pipeline void: if a qb_item_receipt_pipeline row exists for this receipt,
 * we set void_status='waiting' so the cron poller emits a TxnVoid request
 * to QuickBooks.
 */

import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk";

import { PURCHASE_ORDERS_MODULE } from "../../../modules/purchase-orders";
import type PurchaseOrdersModuleService from "../../../modules/purchase-orders/service";

import type { ReceiptReversedDelta } from "./contra-apply-receipt-stock-step";

export interface PersistVoidReceiptStepInput {
  receipt_id: string;
  po_id: string;
  voided_by_user_id: string;
  void_reason: string;
  reversed: ReceiptReversedDelta[];
}

export interface PersistVoidReceiptStepOutput {
  receipt_id: string;
  voided_line_count: number;
  pipeline_void_queued: number;
  po_status_after: "submitted" | "partially_received" | "received";
  total_units_received: number;
}

export const persistVoidReceiptStep = createStep(
  "persist-po-receipt-void-results",
  async (
    input: PersistVoidReceiptStepInput,
    { container }
  ): Promise<StepResponse<PersistVoidReceiptStepOutput, null>> => {
    const service = container.resolve(
      PURCHASE_ORDERS_MODULE
    ) as unknown as PurchaseOrdersModuleService;

    const now = new Date();

    // 1. Mark the receipt header voided
    await service.updatePurchaseOrderReceipts([
      {
        id: input.receipt_id,
        status: "voided",
        voided_at: now,
        voided_by_user_id: input.voided_by_user_id,
        void_reason: input.void_reason,
      },
    ]);

    // 2. Flip stock_applied=false on each reversed receipt line (audit: the
    //    line no longer holds stock parity). We do NOT delete the lines —
    //    they remain as historical record.
    if (input.reversed.length > 0) {
      await service.updatePurchaseOrderReceiptLines(
        input.reversed.map((r) => ({
          id: r.receipt_line_id,
          stock_applied: false,
          stock_applied_at: null,
        }))
      );
    }

    // 3. Recompute affected PurchaseOrderLine counters
    const voidedByPoLineId = new Map<string, number>();
    for (const r of input.reversed) {
      const prev = voidedByPoLineId.get(r.po_line_id) ?? 0;
      // reversed_qty is negative; subtract its absolute value from qty_received
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
    let totalReceivedAfter = 0;

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

    // 4. Recompute PO header status
    const newPoStatus: "submitted" | "partially_received" | "received" =
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

    // 5. Flag the QB item-receipt pipeline row for void (only if it exists
    //    and has been synced — unsynced rows can simply be cancelled instead)
    const pipelineRows = (await service.listQbItemReceiptPipelines(
      { purchase_order_receipt_id: input.receipt_id },
      { take: 10 }
    )) as unknown as Array<{
      id: string;
      status: string;
      qb_list_id: string | null;
    }>;

    let pipelineVoidQueued = 0;
    const pipelineUpdates: Array<Record<string, unknown>> = [];
    for (const p of pipelineRows) {
      if (p.qb_list_id) {
        pipelineUpdates.push({
          id: p.id,
          void_status: "waiting",
          void_retries: 0,
          void_last_error: null,
          void_next_retry_at: null,
        });
        pipelineVoidQueued++;
      } else if (p.status === "waiting" || p.status === "error") {
        // Not yet synced to QB — cancel the waiting add instead of voiding
        pipelineUpdates.push({
          id: p.id,
          status: "cancelled",
        });
      }
    }
    if (pipelineUpdates.length > 0) {
      await service.updateQbItemReceiptPipelines(pipelineUpdates);
    }

    return new StepResponse(
      {
        receipt_id: input.receipt_id,
        voided_line_count: input.reversed.length,
        pipeline_void_queued: pipelineVoidQueued,
        po_status_after: newPoStatus,
        total_units_received: totalReceivedAfter,
      },
      null
    );
  }
);

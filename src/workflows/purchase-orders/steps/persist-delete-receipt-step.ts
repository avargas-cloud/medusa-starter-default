/**
 * src/workflows/purchase-orders/steps/persist-delete-receipt-step.ts
 *
 * Hard-delete persistence for a PurchaseOrderReceipt. Mirrors
 * persistVoidReceiptStep but ends in actual row deletion (FK CASCADE wipes
 * receipt lines and qb_item_receipt_pipeline) instead of leaving a 'voided'
 * tombstone.
 *
 * `vendor_bill` also cascades off this row, which is NOT wanted: deleting a
 * receipt must never destroy a vendor's invoice. Both paths below therefore
 * call `unbindReceiptFromBills` first — see that module for the full rationale.
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
import {
  poHasTracking,
  reconcileReceivedPoStatus,
} from "../../../lib/purchase-orders/po-received-status";
import { unbindReceiptFromBills } from "../../../lib/purchase-orders/unbind-receipt-from-bills";

import type { ReceiptReversedDelta } from "./contra-apply-receipt-stock-step";

export interface PersistDeleteReceiptStepInput {
  receipt_id: string;
  po_id: string;
  deleted_by_user_id: string;
  delete_reason: string;
  reversed: ReceiptReversedDelta[];
  was_already_voided: boolean;
  /** Authoritative QB TxnID from the route's receipt fetch. Source of truth. */
  qb_item_receipt_list_id: string | null;
}

export interface PersistDeleteReceiptStepOutput {
  receipt_id: string;
  hard_deleted: boolean;
  qb_delete_queued: boolean;
  po_status_after: "submitted" | "partially_received" | "received";
  total_units_received: number;
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

    const logger = (container as any).resolve("logger") as
      | { info?: (msg: string) => void }
      | undefined;

    // Raw SQL — see persist-receipt-step.ts for rationale (production
    // incident 2026-04-27, silent service.updateXxx no-op).
    const knex = (
      container as unknown as {
        resolve: (k: string) => {
          raw: (
            sql: string,
            b?: unknown[]
          ) => Promise<{ rows: unknown[]; rowCount?: number }>;
        };
      }
    ).resolve("__pg_connection__");

    // Source of truth for the Path A vs Path B branch: the route handler
    // passes the freshly-read qb_item_receipt_list_id. We DO NOT re-read
    // the receipt here to avoid Mikro-ORM strip-on-relation surprises that
    // historically dropped the field and caused QB-synced receipts to
    // hard-delete via Path A (incident 2026-04-27 RCP-1004).
    const isQbSynced = !!input.qb_item_receipt_list_id;
    logger?.info?.(
      `[persist-delete-receipt] receipt=${input.receipt_id} isQbSynced=${isQbSynced} qb_list_id=${input.qb_item_receipt_list_id ?? "null"}`
    );

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

      const lineUpdates: Array<{
        id: string;
        qty_received: number;
        status: "open" | "partial" | "complete";
      }> = [];
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

      newPoStatus =
        totalReceivedAfter === 0
          ? "submitted"
          : totalReceivedAfter >= totalOrdered
            ? "received"
            : "partially_received";

      for (const lu of lineUpdates) {
        const r = await knex.raw(
          `UPDATE purchase_order_line
              SET qty_received = ?, status = ?, updated_at = NOW()
            WHERE id = ? AND deleted_at IS NULL`,
          [lu.qty_received, lu.status, lu.id]
        );
        if (r.rowCount !== 1) {
          throw new Error(
            `persist-delete-receipt-step: failed to update PO line ${lu.id} (rowCount=${r.rowCount ?? 0}).`
          );
        }
      }

      // Re-derive the display `po_status`. Deleting/voiding a receipt reverses
      // received units, so a "Fully Received" PO drops to "Partial Rcvd Pending
      // Partial" or — if this was the last receipt — to a tracking-aware
      // fallback ("Shipped (Waiting on Arrival)" / "To Arrange Delivery").
      const poHeader = (await service.retrievePurchaseOrder(
        input.po_id
      )) as unknown as { po_status: string | null; tracking: unknown };
      const nextDisplayPoStatus = reconcileReceivedPoStatus(
        poHeader.po_status ?? null,
        newPoStatus,
        totalOrdered,
        totalReceivedAfter,
        poHasTracking(poHeader.tracking)
      );

      const headerR = await knex.raw(
        `UPDATE purchase_order
            SET status = ?, total_units_received = ?,
                po_status = COALESCE(?, po_status), updated_at = NOW()
          WHERE id = ? AND deleted_at IS NULL`,
        [newPoStatus, totalReceivedAfter, nextDisplayPoStatus, input.po_id]
      );
      if (headerR.rowCount !== 1) {
        throw new Error(
          `persist-delete-receipt-step: failed to update PO header ${input.po_id} (rowCount=${headerR.rowCount ?? 0}).`
        );
      }
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

    // Sever every receipt↔bill link BEFORE the row can be destroyed.
    // `vendor_bill.purchase_order_receipt_id` is ON DELETE CASCADE, so a bill
    // still pointing here would be hard-deleted along with all its lines —
    // silently, at the database level. Draft bills reach this step now that
    // they no longer block the delete, so this is what keeps "delete the
    // receipt" from also destroying the vendor's invoice.
    //
    // Placed before the Path A/B branch on purpose: Path A deletes the row
    // immediately, and Path B leaves a tombstone that the QB poller hard-
    // deletes later — the cascade fires on both, just at different times.
    const unbound = await unbindReceiptFromBills(knex, input.receipt_id);
    if (unbound.unbound_bill_ids.length > 0) {
      logger?.info?.(
        `[persist-delete-receipt] receipt=${input.receipt_id} unbound from ${unbound.unbound_bill_ids.length} bill(s): ${unbound.unbound_bill_ids.join(", ")} (cleared ${unbound.cleared_bill_lines} bill line pointer(s))`
      );
    }

    if (!isQbSynced) {
      // Path A — never synced (or already QB-deleted via prior void). Safe to
      // hard-delete now; CASCADE wipes lines + pipeline. Bills are already
      // detached above, so none can be taken by it.
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
    let hasUsablePipelineRow = false;
    for (const p of pipelineRows) {
      if (!p.qb_list_id) continue; // shouldn't happen since isQbSynced=true
      hasUsablePipelineRow = true;
      if (p.void_status === "voided") continue; // already QB-deleted
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

    // Legacy fallback: receipt was QB-synced (header has qb_item_receipt_list_id)
    // but no pipeline row exists yet (e.g., created before the pipeline workflow
    // shipped, or row was previously hard-deleted out from under us). Seed a
    // synthetic pipeline row in 'synced' state with void_status='waiting' so
    // the poller's Phase D fires TxnDel against this list_id.
    if (!hasUsablePipelineRow && input.qb_item_receipt_list_id) {
      const created = await service.createQbItemReceiptPipelines([
        {
          purchase_order_receipt_id: input.receipt_id,
          purchase_order_id: input.po_id,
          status: "synced",
          qb_list_id: input.qb_item_receipt_list_id,
          synced_at: new Date(),
          payload: {
            legacy_seed: true,
            seeded_for: "delete-receipt",
            seeded_at: new Date().toISOString(),
          },
          void_status: "waiting",
          void_retries: 0,
        },
      ]);
      qbDeleteQueued = Array.isArray(created) ? created.length > 0 : !!created;
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

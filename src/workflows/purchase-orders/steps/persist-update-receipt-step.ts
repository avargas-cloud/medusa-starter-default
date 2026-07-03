/**
 * src/workflows/purchase-orders/steps/persist-update-receipt-step.ts
 *
 * Persists the metadata + per-line qty changes of an existing
 * PurchaseOrderReceipt and recomputes PO line/header counters.
 *
 * Inputs:
 *   - vendor_bill_number (optional): metadata-only update on the receipt header.
 *   - line_qty_changes: array of {receipt_line_id, new_qty, po_line_id, delta}.
 *     Only entries with delta != 0 trigger PO line recompute.
 *
 * The PO header status is recomputed from the sum of qty_received across
 * all open PO lines (same logic as receive / delete-receipt steps).
 *
 * Raw SQL is used for line/header writes — service.update* has been
 * silently no-op on this table in past incidents (see persist-receipt-step
 * comments).
 */

import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk";

import { PURCHASE_ORDERS_MODULE } from "../../../modules/purchase-orders";
import type PurchaseOrdersModuleService from "../../../modules/purchase-orders/service";
import {
  poHasTracking,
  reconcileReceivedPoStatus,
} from "../../../lib/purchase-orders/po-received-status";

export interface PersistUpdateReceiptLine {
  receipt_line_id: string;
  po_line_id: string;
  new_qty: number;
  delta: number;
}

export interface PersistUpdateReceiptStepInput {
  receipt_id: string;
  po_id: string;
  vendor_bill_number?: string | null;
  vendor_bill_number_changed: boolean;
  line_changes: PersistUpdateReceiptLine[];
}

export interface PersistUpdateReceiptStepOutput {
  receipt_id: string;
  po_status_after: "submitted" | "partially_received" | "received";
  total_units_received: number;
  lines_updated: number;
}

interface KnexLike {
  raw: (
    sql: string,
    bindings?: unknown[]
  ) => Promise<{ rowCount?: number }>;
}

export const persistUpdateReceiptStep = createStep(
  "persist-po-receipt-update",
  async (
    input: PersistUpdateReceiptStepInput,
    { container }
  ): Promise<StepResponse<PersistUpdateReceiptStepOutput, null>> => {
    const service = container.resolve(
      PURCHASE_ORDERS_MODULE
    ) as unknown as PurchaseOrdersModuleService;

    const knex = (
      container as unknown as { resolve: (k: string) => KnexLike }
    ).resolve("__pg_connection__");

    // ----- 1) Update receipt header (vendor_bill_number) if changed --------
    if (input.vendor_bill_number_changed) {
      const r = await knex.raw(
        `UPDATE purchase_order_receipt
            SET vendor_bill_number = ?, updated_at = NOW()
          WHERE id = ? AND deleted_at IS NULL`,
        [input.vendor_bill_number ?? null, input.receipt_id]
      );
      if (r.rowCount !== 1) {
        throw new Error(
          `persist-update-receipt-step: failed to update receipt ${input.receipt_id} (rowCount=${r.rowCount ?? 0}).`
        );
      }
    }

    // ----- 2) Update receipt lines (qty_received_now) for non-zero deltas --
    const linesToUpdate = input.line_changes.filter((l) => l.delta !== 0);
    for (const lc of linesToUpdate) {
      const r = await knex.raw(
        `UPDATE purchase_order_receipt_line
            SET qty_received_now = ?, updated_at = NOW()
          WHERE id = ? AND deleted_at IS NULL`,
        [lc.new_qty, lc.receipt_line_id]
      );
      if (r.rowCount !== 1) {
        throw new Error(
          `persist-update-receipt-step: failed to update receipt line ${lc.receipt_line_id} (rowCount=${r.rowCount ?? 0}).`
        );
      }
    }

    // ----- 3) Recompute PO line counters + PO header status ----------------
    const poLines = (await service.listPurchaseOrderLines(
      { purchase_order_id: input.po_id },
      { take: 1000 }
    )) as unknown as Array<{
      id: string;
      qty_ordered: number;
      qty_received: number;
    }>;

    // Aggregate deltas by po_line_id
    const deltaByPoLine = new Map<string, number>();
    for (const lc of linesToUpdate) {
      deltaByPoLine.set(
        lc.po_line_id,
        (deltaByPoLine.get(lc.po_line_id) ?? 0) + lc.delta
      );
    }

    let totalOrdered = 0;
    let totalReceivedAfter = 0;
    const lineUpdates: Array<{
      id: string;
      qty_received: number;
      status: "open" | "partial" | "complete";
    }> = [];

    for (const pol of poLines) {
      const delta = deltaByPoLine.get(pol.id) ?? 0;
      const newReceived = Math.max(0, pol.qty_received + delta);
      const newStatus =
        newReceived === 0
          ? "open"
          : newReceived < pol.qty_ordered
            ? "partial"
            : "complete";

      if (delta !== 0) {
        lineUpdates.push({
          id: pol.id,
          qty_received: newReceived,
          status: newStatus,
        });
      }

      totalOrdered += pol.qty_ordered;
      totalReceivedAfter += newReceived;
    }

    for (const lu of lineUpdates) {
      const r = await knex.raw(
        `UPDATE purchase_order_line
            SET qty_received = ?, status = ?, updated_at = NOW()
          WHERE id = ? AND deleted_at IS NULL`,
        [lu.qty_received, lu.status, lu.id]
      );
      if (r.rowCount !== 1) {
        throw new Error(
          `persist-update-receipt-step: failed to update PO line ${lu.id} (rowCount=${r.rowCount ?? 0}).`
        );
      }
    }

    const newPoStatus: "submitted" | "partially_received" | "received" =
      totalReceivedAfter === 0
        ? "submitted"
        : totalReceivedAfter >= totalOrdered
          ? "received"
          : "partially_received";

    // Re-derive the display `po_status`. Editing a receipt down can drop the PO
    // out of "Fully Received" → partial, or to zero → tracking-aware fallback.
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
        `persist-update-receipt-step: failed to update PO header ${input.po_id} (rowCount=${headerR.rowCount ?? 0}).`
      );
    }

    return new StepResponse(
      {
        receipt_id: input.receipt_id,
        po_status_after: newPoStatus,
        total_units_received: totalReceivedAfter,
        lines_updated: linesToUpdate.length,
      },
      null
    );
  }
);

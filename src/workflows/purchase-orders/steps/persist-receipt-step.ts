/**
 * src/workflows/purchase-orders/steps/persist-receipt-step.ts
 *
 * Creates the PurchaseOrderReceipt header + N PurchaseOrderReceiptLine rows,
 * refreshes the denormalized counters on each affected PurchaseOrderLine
 * (qty_received, status), and updates the PO header counters + status.
 *
 * Status transitions applied to the header:
 *   - total_units_received < total_units_ordered → 'partially_received'
 *   - total_units_received >= total_units_ordered → 'received'
 *
 * Per-line status transitions:
 *   - qty_received == 0 → unchanged (remains 'open')
 *   - 0 < qty_received < qty_ordered → 'partial'
 *   - qty_received >= qty_ordered → 'complete'
 *
 * No compensation: if this step fails AFTER the stock has been applied,
 * the compensation on apply-receipt-stock-step will back out the inventory
 * movement. Leaving the receipt rows half-created would be inconsistent,
 * so we commit everything here in a single service call chain.
 */

import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk";

import { PURCHASE_ORDERS_MODULE } from "../../../modules/purchase-orders";
import type PurchaseOrdersModuleService from "../../../modules/purchase-orders/service";

import type { ReceiptAppliedDelta } from "./apply-receipt-stock-step";

export interface PersistReceiptStepInputLine {
  po_line_id: string;
  product_variant_id: string;
  inventory_item_id: string;
  sku_snapshot: string;
  description_snapshot: string;
  qb_item_list_id_snapshot: string | null;
  qty_received_now: number;
  unit_cost_cents_override: number | null;
}

export interface PersistReceiptStepInput {
  po_id: string;
  receipt_seq: number;
  receipt_number: string;
  received_by_user_id: string;
  stock_location_id: string;
  received_at: Date;
  vendor_bill_number: string | null;
  vendor_bill_date: Date | null;
  notes: string | null;
  applied: ReceiptAppliedDelta[];
  lines: PersistReceiptStepInputLine[];
}

export interface PersistReceiptStepOutput {
  receipt_id: string;
  receipt_line_ids: string[];
  po_status_after: "partially_received" | "received";
  total_units_received: number;
  total_units_ordered: number;
}

export const persistReceiptStep = createStep(
  "persist-po-receipt",
  async (
    input: PersistReceiptStepInput,
    { container }
  ): Promise<StepResponse<PersistReceiptStepOutput, null>> => {
    const service = container.resolve(
      PURCHASE_ORDERS_MODULE
    ) as unknown as PurchaseOrdersModuleService;

    // Map applied deltas by po_line_id for quick stock_applied lookup
    const appliedByLineId = new Map<string, ReceiptAppliedDelta>();
    for (const a of input.applied) appliedByLineId.set(a.po_line_id, a);

    // 1. Create the receipt header — status='applied' (stock already moved)
    const createdReceipt = await service.createPurchaseOrderReceipts([
      {
        purchase_order_id: input.po_id,
        number: input.receipt_number,
        seq: input.receipt_seq,
        status: "applied",
        received_at: input.received_at,
        received_by_user_id: input.received_by_user_id,
        stock_location_id: input.stock_location_id,
        vendor_bill_number: input.vendor_bill_number,
        vendor_bill_date: input.vendor_bill_date,
        notes: input.notes,
      },
    ]);
    const receiptArr = Array.isArray(createdReceipt)
      ? createdReceipt
      : [createdReceipt];
    const receiptRow = receiptArr[0] as { id: string };
    const receiptId = receiptRow.id;

    // 2. Create receipt lines
    const receiptLinePayload = input.lines.map((l) => {
      const applied = appliedByLineId.get(l.po_line_id);
      const isApplied = Boolean(applied);
      return {
        purchase_order_receipt_id: receiptId,
        purchase_order_line_id: l.po_line_id,
        purchase_order_id: input.po_id,
        product_variant_id: l.product_variant_id,
        inventory_item_id: l.inventory_item_id,
        sku_snapshot: l.sku_snapshot,
        description_snapshot: l.description_snapshot,
        qb_item_list_id_snapshot: l.qb_item_list_id_snapshot,
        qty_received_now: l.qty_received_now,
        unit_cost_cents_override: l.unit_cost_cents_override,
        stock_applied: isApplied,
        stock_applied_at: isApplied ? input.received_at : null,
      };
    });

    const createdReceiptLines =
      await service.createPurchaseOrderReceiptLines(receiptLinePayload);
    const receiptLinesArr = Array.isArray(createdReceiptLines)
      ? createdReceiptLines
      : [createdReceiptLines];
    const receiptLineIds = receiptLinesArr.map((r) => (r as { id: string }).id);

    // 3. Refresh affected PurchaseOrderLine counters + status
    // Read current PO lines to compute new qty_received by aggregating all
    // non-voided receipt lines for each po_line_id.
    const poLines = (await service.listPurchaseOrderLines(
      { purchase_order_id: input.po_id },
      { take: 1000 }
    )) as unknown as Array<{
      id: string;
      qty_ordered: number;
      qty_received: number;
    }>;

    const receiptDeltasByLineId = new Map<string, number>();
    for (const l of input.lines) {
      const prev = receiptDeltasByLineId.get(l.po_line_id) ?? 0;
      receiptDeltasByLineId.set(l.po_line_id, prev + l.qty_received_now);
    }

    const lineUpdates: Array<{
      id: string;
      qty_received: number;
      status: "open" | "partial" | "complete";
    }> = [];
    let totalOrdered = 0;
    let totalReceivedAfter = 0;

    for (const pol of poLines) {
      const delta = receiptDeltasByLineId.get(pol.id) ?? 0;
      const newReceived = pol.qty_received + delta;
      const newStatus =
        newReceived === 0
          ? "open"
          : newReceived < pol.qty_ordered
            ? "partial"
            : "complete";

      if (delta > 0) {
        lineUpdates.push({
          id: pol.id,
          qty_received: newReceived,
          status: newStatus,
        });
      }
      totalOrdered += pol.qty_ordered;
      totalReceivedAfter += newReceived;
    }

    // 4. Update PO header counters + status
    const newPoStatus: "partially_received" | "received" =
      totalReceivedAfter >= totalOrdered ? "received" : "partially_received";

    // Use raw SQL (knex) instead of service.updateXxx — eliminates any
    // MikroORM identity-map / change-detection ambiguity. Same pattern as
    // qb-purchase-order-poller.ts:374 and qb-item-receipt-poller.ts:234.
    // Production incident 2026-04-27: PO-1006 / RCP-1001 had receipt rows
    // committed but counters silently never persisted via service.updateXxx.
    const knex = (
      container as unknown as {
        resolve: (k: string) => {
          raw: (sql: string, b?: unknown[]) => Promise<{ rowCount?: number }>;
        };
      }
    ).resolve("__pg_connection__");

    for (const lu of lineUpdates) {
      const r = await knex.raw(
        `UPDATE purchase_order_line
            SET qty_received = ?, status = ?, updated_at = NOW()
          WHERE id = ? AND deleted_at IS NULL`,
        [lu.qty_received, lu.status, lu.id]
      );
      if (r.rowCount !== 1) {
        throw new Error(
          `persist-receipt-step: failed to update PO line ${String(lu.id)} (rowCount=${r.rowCount ?? 0}). ` +
            `Aborting workflow to surface counter drift.`
        );
      }
    }

    const headerR = await knex.raw(
      `UPDATE purchase_order
          SET status = ?, total_units_received = ?, updated_at = NOW()
        WHERE id = ? AND deleted_at IS NULL`,
      [newPoStatus, totalReceivedAfter, input.po_id]
    );
    if (headerR.rowCount !== 1) {
      throw new Error(
        `persist-receipt-step: failed to update PO header ${input.po_id} (rowCount=${headerR.rowCount ?? 0}).`
      );
    }

    return new StepResponse(
      {
        receipt_id: receiptId,
        receipt_line_ids: receiptLineIds,
        po_status_after: newPoStatus,
        total_units_received: totalReceivedAfter,
        total_units_ordered: totalOrdered,
      },
      null
    );
  }
);

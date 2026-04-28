import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk";

import { FACTORY_ORDERS_MODULE } from "../../../modules/factory-orders";
import type FactoryOrdersModuleService from "../../../modules/factory-orders/service";

import type { FoReceiptAppliedDelta } from "./apply-fo-receipt-stock-step";

export interface PersistFoReceiptStepInputLine {
  fo_line_id: string;
  product_variant_id: string;
  inventory_item_id: string;
  sku_snapshot: string;
  description_snapshot: string;
  qty_received_now: number;
  unit_cost_cents_override: number | null;
}

export interface PersistFoReceiptStepInput {
  fo_id: string;
  receipt_seq: number;
  receipt_number: string;
  received_by_user_id: string;
  stock_location_id: string;
  received_at: Date;
  notes: string | null;
  applied: FoReceiptAppliedDelta[];
  lines: PersistFoReceiptStepInputLine[];
}

export interface PersistFoReceiptStepOutput {
  receipt_id: string;
  receipt_line_ids: string[];
  fo_status_after: "partially_received" | "received";
  total_units_received: number;
  total_units_ordered: number;
}

export const persistFoReceiptStep = createStep(
  "persist-fo-receipt",
  async (
    input: PersistFoReceiptStepInput,
    { container }
  ): Promise<StepResponse<PersistFoReceiptStepOutput, null>> => {
    const service = container.resolve(
      FACTORY_ORDERS_MODULE
    ) as unknown as FactoryOrdersModuleService;

    const appliedByLineId = new Map<string, FoReceiptAppliedDelta>();
    for (const a of input.applied) appliedByLineId.set(a.fo_line_id, a);

    // 1. Create receipt header
    const createdReceipt = await service.createFactoryOrderReceipts([
      {
        factory_order_id: input.fo_id,
        number: input.receipt_number,
        seq: input.receipt_seq,
        status: "applied",
        received_at: input.received_at,
        received_by_user_id: input.received_by_user_id,
        stock_location_id: input.stock_location_id,
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
      const applied = appliedByLineId.get(l.fo_line_id);
      const isApplied = Boolean(applied);
      return {
        factory_order_receipt_id: receiptId,
        factory_order_line_id: l.fo_line_id,
        factory_order_id: input.fo_id,
        product_variant_id: l.product_variant_id,
        inventory_item_id: l.inventory_item_id,
        sku_snapshot: l.sku_snapshot,
        description_snapshot: l.description_snapshot,
        qty_received_now: l.qty_received_now,
        unit_cost_cents_override: l.unit_cost_cents_override,
        stock_applied: isApplied,
        stock_applied_at: isApplied ? input.received_at : null,
      };
    });

    const createdLines =
      await service.createFactoryOrderReceiptLines(receiptLinePayload);
    const linesArr = Array.isArray(createdLines) ? createdLines : [createdLines];
    const receiptLineIds = linesArr.map((r) => (r as { id: string }).id);

    // 3. Refresh FO line counters + status via raw SQL
    // (service.updateXxx had silent no-op issues — raw SQL is authoritative)
    const knex = (
      container as unknown as {
        resolve: (k: string) => {
          raw: (sql: string, b?: unknown[]) => Promise<{ rowCount?: number }>;
        };
      }
    ).resolve("__pg_connection__");

    const foLines = (await service.listFactoryOrderLines(
      { factory_order_id: input.fo_id },
      { take: 1000 }
    )) as unknown as Array<{
      id: string;
      qty_ordered: number;
      qty_received: number;
    }>;

    const receiptDeltasByLineId = new Map<string, number>();
    for (const l of input.lines) {
      const prev = receiptDeltasByLineId.get(l.fo_line_id) ?? 0;
      receiptDeltasByLineId.set(l.fo_line_id, prev + l.qty_received_now);
    }

    const lineUpdates: Array<{
      id: string;
      qty_received: number;
      status: "open" | "partial" | "complete";
    }> = [];
    let totalOrdered = 0;
    let totalReceivedAfter = 0;

    for (const fol of foLines) {
      const delta = receiptDeltasByLineId.get(fol.id) ?? 0;
      const newReceived = fol.qty_received + delta;
      const newStatus =
        newReceived === 0
          ? "open"
          : newReceived < fol.qty_ordered
            ? "partial"
            : "complete";

      if (delta > 0) {
        lineUpdates.push({ id: fol.id, qty_received: newReceived, status: newStatus });
      }
      totalOrdered += fol.qty_ordered;
      totalReceivedAfter += newReceived;
    }

    for (const lu of lineUpdates) {
      const r = await knex.raw(
        `UPDATE factory_order_line
            SET qty_received = ?, status = ?, updated_at = NOW()
          WHERE id = ? AND deleted_at IS NULL`,
        [lu.qty_received, lu.status, lu.id]
      );
      if (r.rowCount !== 1) {
        throw new Error(
          `persist-fo-receipt-step: failed to update FO line ${lu.id} (rowCount=${r.rowCount ?? 0}).`
        );
      }
    }

    const newFoStatus: "partially_received" | "received" =
      totalReceivedAfter >= totalOrdered ? "received" : "partially_received";

    const headerR = await knex.raw(
      `UPDATE factory_order
          SET status = ?, total_units_received = ?, updated_at = NOW()
        WHERE id = ? AND deleted_at IS NULL`,
      [newFoStatus, totalReceivedAfter, input.fo_id]
    );
    if (headerR.rowCount !== 1) {
      throw new Error(
        `persist-fo-receipt-step: failed to update FO header ${input.fo_id} (rowCount=${headerR.rowCount ?? 0}).`
      );
    }

    return new StepResponse(
      {
        receipt_id: receiptId,
        receipt_line_ids: receiptLineIds,
        fo_status_after: newFoStatus,
        total_units_received: totalReceivedAfter,
        total_units_ordered: totalOrdered,
      },
      null
    );
  }
);

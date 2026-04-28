import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk";

import { FACTORY_ORDERS_MODULE } from "../../../modules/factory-orders";
import type FactoryOrdersModuleService from "../../../modules/factory-orders/service";

export interface PersistUpdateFoReceiptLine {
  receipt_line_id: string;
  fo_line_id: string;
  new_qty: number;
  delta: number;
}

export interface PersistUpdateFoReceiptStepInput {
  receipt_id: string;
  fo_id: string;
  line_changes: PersistUpdateFoReceiptLine[];
}

export interface PersistUpdateFoReceiptStepOutput {
  receipt_id: string;
  fo_status_after: "submitted" | "partially_received" | "received";
  total_units_received: number;
  lines_updated: number;
}

interface KnexLike {
  raw: (sql: string, bindings?: unknown[]) => Promise<{ rowCount?: number }>;
}

export const persistUpdateFoReceiptStep = createStep(
  "persist-fo-receipt-update",
  async (
    input: PersistUpdateFoReceiptStepInput,
    { container }
  ): Promise<StepResponse<PersistUpdateFoReceiptStepOutput, null>> => {
    const service = container.resolve(
      FACTORY_ORDERS_MODULE
    ) as unknown as FactoryOrdersModuleService;

    const knex = (
      container as unknown as { resolve: (k: string) => KnexLike }
    ).resolve("__pg_connection__");

    // 1. Update receipt lines (qty_received_now) for non-zero deltas
    const linesToUpdate = input.line_changes.filter((l) => l.delta !== 0);
    for (const lc of linesToUpdate) {
      const r = await knex.raw(
        `UPDATE factory_order_receipt_line
            SET qty_received_now = ?, updated_at = NOW()
          WHERE id = ? AND deleted_at IS NULL`,
        [lc.new_qty, lc.receipt_line_id]
      );
      if (r.rowCount !== 1) {
        throw new Error(
          `persist-update-fo-receipt-step: failed to update receipt line ${lc.receipt_line_id} (rowCount=${r.rowCount ?? 0}).`
        );
      }
    }

    // 2. Recompute FO line counters + header status
    const foLines = (await service.listFactoryOrderLines(
      { factory_order_id: input.fo_id },
      { take: 1000 }
    )) as unknown as Array<{
      id: string;
      qty_ordered: number;
      qty_received: number;
    }>;

    const deltaByFoLine = new Map<string, number>();
    for (const lc of linesToUpdate) {
      deltaByFoLine.set(
        lc.fo_line_id,
        (deltaByFoLine.get(lc.fo_line_id) ?? 0) + lc.delta
      );
    }

    let totalOrdered = 0;
    let totalReceivedAfter = 0;
    const lineUpdates: Array<{
      id: string;
      qty_received: number;
      status: "open" | "partial" | "complete";
    }> = [];

    for (const fol of foLines) {
      const delta = deltaByFoLine.get(fol.id) ?? 0;
      const newReceived = Math.max(0, fol.qty_received + delta);
      const newStatus =
        newReceived === 0
          ? "open"
          : newReceived < fol.qty_ordered
            ? "partial"
            : "complete";

      if (delta !== 0) {
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
          `persist-update-fo-receipt-step: failed to update FO line ${lu.id} (rowCount=${r.rowCount ?? 0}).`
        );
      }
    }

    const newFoStatus: "submitted" | "partially_received" | "received" =
      totalReceivedAfter === 0
        ? "submitted"
        : totalReceivedAfter >= totalOrdered
          ? "received"
          : "partially_received";

    const headerR = await knex.raw(
      `UPDATE factory_order
          SET status = ?, total_units_received = ?, updated_at = NOW()
        WHERE id = ? AND deleted_at IS NULL`,
      [newFoStatus, totalReceivedAfter, input.fo_id]
    );
    if (headerR.rowCount !== 1) {
      throw new Error(
        `persist-update-fo-receipt-step: failed to update FO header ${input.fo_id} (rowCount=${headerR.rowCount ?? 0}).`
      );
    }

    return new StepResponse(
      {
        receipt_id: input.receipt_id,
        fo_status_after: newFoStatus,
        total_units_received: totalReceivedAfter,
        lines_updated: linesToUpdate.length,
      },
      null
    );
  }
);

import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk";

import { FACTORY_ORDERS_MODULE } from "../../../modules/factory-orders";
import type FactoryOrdersModuleService from "../../../modules/factory-orders/service";

import type { FoReceiptReversedDelta } from "./contra-apply-fo-receipt-stock-step";

export interface PersistDeleteFoReceiptStepInput {
  receipt_id: string;
  fo_id: string;
  deleted_by_user_id: string;
  delete_reason: string;
  reversed: FoReceiptReversedDelta[];
  was_already_voided: boolean;
}

export interface PersistDeleteFoReceiptStepOutput {
  receipt_id: string;
  hard_deleted: boolean;
  fo_status_after: "submitted" | "partially_received" | "received";
  total_units_received: number;
}

export const persistDeleteFoReceiptStep = createStep(
  "persist-fo-receipt-delete",
  async (
    input: PersistDeleteFoReceiptStepInput,
    { container }
  ): Promise<StepResponse<PersistDeleteFoReceiptStepOutput, null>> => {
    const service = container.resolve(
      FACTORY_ORDERS_MODULE
    ) as unknown as FactoryOrdersModuleService;

    let totalReceivedAfter = 0;
    let newFoStatus: "submitted" | "partially_received" | "received" =
      "submitted";

    if (!input.was_already_voided) {
      const voidedByFoLineId = new Map<string, number>();
      for (const r of input.reversed) {
        const prev = voidedByFoLineId.get(r.fo_line_id) ?? 0;
        voidedByFoLineId.set(r.fo_line_id, prev + Math.abs(r.reversed_qty));
      }

      const foLines = (await service.listFactoryOrderLines(
        { factory_order_id: input.fo_id },
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

      for (const fol of foLines) {
        const voidedQty = voidedByFoLineId.get(fol.id) ?? 0;
        const newReceived = Math.max(0, fol.qty_received - voidedQty);
        const newStatus =
          newReceived === 0
            ? "open"
            : newReceived < fol.qty_ordered
              ? "partial"
              : "complete";

        if (voidedQty > 0) {
          lineUpdates.push({ id: fol.id, qty_received: newReceived, status: newStatus });
        }
        totalOrdered += fol.qty_ordered;
        totalReceivedAfter += newReceived;
      }

      newFoStatus =
        totalReceivedAfter === 0
          ? "submitted"
          : totalReceivedAfter >= totalOrdered
            ? "received"
            : "partially_received";

      const knex = (
        container as unknown as {
          resolve: (k: string) => {
            raw: (sql: string, b?: unknown[]) => Promise<{ rowCount?: number }>;
          };
        }
      ).resolve("__pg_connection__");

      for (const lu of lineUpdates) {
        const r = await knex.raw(
          `UPDATE factory_order_line
              SET qty_received = ?, status = ?, updated_at = NOW()
            WHERE id = ? AND deleted_at IS NULL`,
          [lu.qty_received, lu.status, lu.id]
        );
        if (r.rowCount !== 1) {
          throw new Error(
            `persist-delete-fo-receipt-step: failed to update FO line ${lu.id} (rowCount=${r.rowCount ?? 0}).`
          );
        }
      }

      const headerR = await knex.raw(
        `UPDATE factory_order
            SET status = ?, total_units_received = ?, updated_at = NOW()
          WHERE id = ? AND deleted_at IS NULL`,
        [newFoStatus, totalReceivedAfter, input.fo_id]
      );
      if (headerR.rowCount !== 1) {
        throw new Error(
          `persist-delete-fo-receipt-step: failed to update FO header ${input.fo_id} (rowCount=${headerR.rowCount ?? 0}).`
        );
      }
    } else {
      // Already voided: counters are correct, just read them back
      const fo = (await service.retrieveFactoryOrder(
        input.fo_id
      )) as unknown as {
        status: "submitted" | "partially_received" | "received";
        total_units_received: number;
      };
      newFoStatus = fo.status;
      totalReceivedAfter = fo.total_units_received;
    }

    // Always Path A — no QB sync, always hard delete (FK CASCADE wipes lines)
    await service.deleteFactoryOrderReceipts([input.receipt_id]);

    return new StepResponse(
      {
        receipt_id: input.receipt_id,
        hard_deleted: true,
        fo_status_after: newFoStatus,
        total_units_received: totalReceivedAfter,
      },
      null
    );
  }
);

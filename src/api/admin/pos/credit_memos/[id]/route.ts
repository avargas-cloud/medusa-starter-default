import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

import { CREDIT_MEMO_MODULE } from "../../../../../modules/credit_memos";
import CreditMemoModuleService from "../../../../../modules/credit_memos/service";

export async function GET(
  req: MedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const logger = req.scope.resolve("logger");
  const creditMemoService: CreditMemoModuleService =
    req.scope.resolve(CREDIT_MEMO_MODULE);
  const { id } = req.params as { id: string };

  try {
    const creditMemo = await creditMemoService.retrievePosCreditMemo(id, {
      relations: ["items"],
    });

    if (!creditMemo) {
      res.status(404).json({ message: "Credit Memo not found" });
      return;
    }

    const pgConnection = req.scope.resolve("__pg_connection__") as any;

    // Enrich with associated payment data
    let payment_id: string | null = null;
    let payment_display_id: number | null = null;
    let credit_available: number | null = null;
    if ((creditMemo as any).credit_memo_number) {
      try {
        const payRow = await pgConnection("customer_payment as cp")
          .leftJoin("payment_application as pa", function (this: any) {
            this.on("pa.payment_id", "=", "cp.id")
              .andOnNull("pa.voided_at")
              .andOnNull("pa.deleted_at");
          })
          .where({
            "cp.reference": (creditMemo as any).credit_memo_number,
            "cp.type": "credit_memo",
          })
          .whereNull("cp.deleted_at")
          .groupBy("cp.id", "cp.display_id", "cp.status", "cp.amount")
          .select(
            "cp.id",
            "cp.display_id",
            "cp.status",
            "cp.amount",
            pgConnection.raw(
              "COALESCE(SUM(pa.amount_applied), 0) as applied_total"
            )
          )
          .first();
        if (payRow) {
          payment_id = payRow.id;
          payment_display_id = payRow.display_id ?? null;
          const isCredit =
            payRow.status === "available" ||
            payRow.status === "partially_applied";
          credit_available = isCredit
            ? Math.max(0, Number(payRow.amount) - Number(payRow.applied_total))
            : 0;
        }
      } catch {
        /* non-critical */
      }
    }

    // Enrich with real QB reference number from the pipeline
    let qb_ref_number: string | null = null;
    if ((creditMemo as any).qb_txn_id) {
      try {
        const pipelineRow = await pgConnection("qb_order_pipeline")
          .where({
            qb_txn_id: (creditMemo as any).qb_txn_id,
            step: "credit_memo",
            status: "confirmed",
          })
          .select("qb_ref_number")
          .first();
        qb_ref_number = pipelineRow?.qb_ref_number ?? null;
      } catch {
        /* non-critical */
      }
    }

    // Enrich with invoice_number from pos_invoice if invoice_id is present
    let invoice_number: string | null = null;
    if ((creditMemo as any).invoice_id) {
      try {
        const row = await pgConnection("pos_invoice")
          .where({ id: (creditMemo as any).invoice_id })
          .select("invoice_number")
          .first();
        invoice_number = row?.invoice_number ?? null;
      } catch {
        /* non-critical */
      }
    }

    // Enrich with order display_id for friendly reference in the UI
    let order_display_id: number | null = null;
    if ((creditMemo as any).order_id) {
      try {
        const row = await pgConnection("order")
          .where({ id: (creditMemo as any).order_id })
          .select("display_id")
          .first();
        order_display_id = row?.display_id ?? null;
      } catch {
        /* non-critical */
      }
    }

    res.status(200).json({
      credit_memo: {
        ...creditMemo,
        invoice_number,
        order_display_id,
        qb_ref_number,
        payment_id,
        payment_display_id,
        credit_available,
      },
    });
  } catch (e: any) {
    logger.error(`[credit_memos GET] failed: ${e.message}`);
    res.status(500).json({ success: false, message: e.message });
  }
}

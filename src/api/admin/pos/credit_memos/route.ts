import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { Modules } from "@medusajs/utils";

import { CREDIT_MEMO_MODULE } from "../../../../modules/credit_memos";
import CreditMemoModuleService from "../../../../modules/credit_memos/service";

export async function GET(
  req: MedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const logger = req.scope.resolve("logger");
  const creditMemoService: CreditMemoModuleService =
    req.scope.resolve(CREDIT_MEMO_MODULE);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const customerModule = req.scope.resolve(Modules.CUSTOMER) as any;
  const { skip = "0", take = "200" } = req.query as Record<string, string>;

  try {
    const [creditMemos, count] =
      await creditMemoService.listAndCountPosCreditMemos(
        {},
        {
          skip: parseInt(skip),
          take: parseInt(take),
          relations: ["items"],
        }
      );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pgConnection = req.scope.resolve("__pg_connection__") as any;

    // Enrich with customer data in a single batch query
    const customerIds = [
      ...new Set(creditMemos.map((m: any) => m.customer_id).filter(Boolean)),
    ];
    const customers = customerIds.length
      ? await customerModule.listCustomers(
          { id: customerIds },
          {
            select: [
              "id",
              "first_name",
              "last_name",
              "email",
              "phone",
              "company_name",
            ],
          }
        )
      : [];
    const customerMap = Object.fromEntries(
      customers.map((c: any) => [c.id, c])
    );

    // Batch-fetch available credit per credit memo (accounts for partial applications)
    const cmNumbers = creditMemos
      .map((m: any) => m.credit_memo_number)
      .filter(Boolean);
    const payments = cmNumbers.length
      ? await pgConnection("customer_payment as cp")
          .leftJoin("payment_application as pa", function (this: any) {
            this.on("pa.payment_id", "=", "cp.id")
              .andOnNull("pa.voided_at")
              .andOnNull("pa.deleted_at");
          })
          .whereIn("cp.reference", cmNumbers)
          .where({ "cp.type": "credit_memo" })
          .whereNull("cp.deleted_at")
          .groupBy("cp.reference", "cp.status", "cp.amount")
          .select(
            "cp.reference",
            "cp.status",
            "cp.amount",
            pgConnection.raw(
              "COALESCE(SUM(pa.amount_applied), 0) as applied_total"
            )
          )
      : [];
    const creditAvailMap: Record<string, number> = {};
    for (const p of payments) {
      const isCredit =
        p.status === "available" || p.status === "partially_applied";
      creditAvailMap[p.reference] = isCredit
        ? Math.max(0, Number(p.amount) - Number(p.applied_total))
        : 0;
    }

    // Batch-fetch real QB reference numbers from the pipeline
    const txnIds = creditMemos.map((m: any) => m.qb_txn_id).filter(Boolean);
    const pipelineRows = txnIds.length
      ? await pgConnection("qb_order_pipeline")
          .whereIn("qb_txn_id", txnIds)
          .where({ step: "credit_memo", status: "confirmed" })
          .select("qb_txn_id", "qb_ref_number")
      : [];
    const qbRefMap: Record<string, string | null> = {};
    for (const row of pipelineRows) {
      qbRefMap[row.qb_txn_id] = row.qb_ref_number ?? null;
    }

    const enriched = creditMemos.map((m: any) => ({
      ...m,
      customer: customerMap[m.customer_id] ?? null,
      credit_available:
        m.credit_memo_number != null
          ? (creditAvailMap[m.credit_memo_number] ?? null)
          : null,
      qb_ref_number: m.qb_txn_id ? (qbRefMap[m.qb_txn_id] ?? null) : null,
    }));

    res.status(200).json({ credit_memos: enriched, count });
  } catch (e: any) {
    logger.error(`[credit_memos list GET] failed: ${e.message}`, e);
    const keys = Object.keys(creditMemoService || {}).filter((k) =>
      k.includes("list")
    );
    res.status(500).json({
      success: false,
      message: e.message,
      stack: e.stack,
      availableMethods: keys,
    });
  }
}

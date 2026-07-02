import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

import { CREDIT_MEMO_MODULE } from "../../../../../modules/credit_memos";
import CreditMemoModuleService from "../../../../../modules/credit_memos/service";
import { sortDocItemsByInsertion } from "../../../invoices/_lib/item-order";

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

    // Enrich with customer display fields so the frontend can hydrate without a second fetch
    let customer_name: string | null = null;
    let customer_email: string | null = null;
    let customer_phone: string | null = null;
    let customer_company: string | null = null;
    if ((creditMemo as any).customer_id) {
      try {
        const cust = await pgConnection("customer")
          .where({ id: (creditMemo as any).customer_id })
          .select("first_name", "last_name", "email", "phone", "company_name")
          .first();
        if (cust) {
          customer_name =
            `${cust.first_name ?? ""} ${cust.last_name ?? ""}`.trim() || null;
          customer_email = cust.email ?? null;
          customer_phone = cust.phone ?? null;
          customer_company = cust.company_name ?? null;
        }
      } catch {
        /* non-critical */
      }
    }

    // The `items` hasMany has no default ORDER BY → restore insertion (ULID id)
    // order so comment/header lines stay where the operator placed them.
    const memoItems = sortDocItemsByInsertion(
      (creditMemo as any).items
    ) as Array<{
      variant_id?: string | null;
      thumbnail?: string | null;
      [key: string]: unknown;
    }>;
    const variantIds = [
      ...new Set(memoItems.map((item) => item.variant_id).filter(Boolean)),
    ] as string[];
    const thumbnailByVariantId = new Map<string, string | null>();

    if (variantIds.length > 0) {
      try {
        const rows = await pgConnection.raw(
          `SELECT pv.id,
                  COALESCE(pv.thumbnail, p.thumbnail) AS thumbnail
             FROM product_variant pv
             LEFT JOIN product p ON p.id = pv.product_id
            WHERE pv.id = ANY(?)`,
          [variantIds]
        );

        for (const row of rows.rows ?? []) {
          thumbnailByVariantId.set(row.id, row.thumbnail ?? null);
        }
      } catch {
        /* non-critical */
      }
    }

    const hydratedItems = memoItems.map((item) => ({
      ...item,
      thumbnail: item.variant_id
        ? thumbnailByVariantId.get(item.variant_id) ?? item.thumbnail ?? null
        : item.thumbnail ?? null,
    }));

    res.status(200).json({
      credit_memo: {
        ...creditMemo,
        items: hydratedItems,
        invoice_number,
        order_display_id,
        qb_ref_number,
        payment_id,
        payment_display_id,
        credit_available,
        customer_name,
        customer_email,
        customer_phone,
        customer_company,
      },
    });
  } catch (e: any) {
    logger.error(`[credit_memos GET] failed: ${e.message}`);
    res.status(500).json({ success: false, message: e.message });
  }
}

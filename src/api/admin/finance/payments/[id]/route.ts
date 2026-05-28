import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

import { FINANCE_MODULE } from "../../../../../modules/finance";
import { getDbPool } from "../../../../utils/db-pool";

/**
 * GET /admin/finance/payments/:id
 * Retrieves a single customer payment and its applications, enriched with
 * each application's order_document_number (joined from order.metadata) so
 * the Credit Statement can label rows as "Deposit for Order S#####" instead
 * of a raw UUID slice.
 */
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const financeService = req.scope.resolve(FINANCE_MODULE);
  const id = req.params.id as string;

  try {
    const payment = await financeService.retrieveCustomerPayment(id, {
      relations: ["applications"],
    });

    if (!payment) {
      return res.status(404).json({ error: "Payment not found" });
    }

    const applications = (payment as { applications?: { order_id?: string }[] })
      .applications;
    if (applications && applications.length > 0) {
      const orderIds = Array.from(
        new Set(
          applications.map((a) => a.order_id).filter(Boolean) as string[]
        )
      );
      if (orderIds.length > 0) {
        const pool = getDbPool();
        const { rows } = await pool.query<{
          id: string;
          document_number: string | null;
        }>(
          `SELECT id, NULLIF(metadata->>'document_number','') AS document_number
           FROM "order"
           WHERE id = ANY($1::text[])`,
          [orderIds]
        );
        const docNumberByOrder = new Map<string, string | null>();
        for (const r of rows) docNumberByOrder.set(r.id, r.document_number);
        for (const a of applications as Record<string, unknown>[]) {
          const oid = a.order_id as string | undefined;
          if (oid) {
            (
              a as { order_document_number?: string | null }
            ).order_document_number = docNumberByOrder.get(oid) ?? null;
          }
        }
      }
    }

    return res.json({ payment });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
}

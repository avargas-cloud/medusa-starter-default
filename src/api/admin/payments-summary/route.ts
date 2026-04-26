import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

export interface PaymentSummaryDay {
  date: string;
  amount: number;
  count: number;
}

/**
 * GET /admin/payments-summary?from=ISO&to=ISO
 * Returns daily totals of customer_payments received in the given range.
 * Excludes credit_memo method (not real cash) and refunded status.
 * Amounts in cents.
 */
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const { from, to } = req.query as { from?: string; to?: string };

  if (!from || !to) {
    return res.status(400).json({
      error: "Query params 'from' and 'to' are required (ISO strings)",
    });
  }

  try {
    const pgConnection = req.scope.resolve("__pg_connection__") as any;

    // Net cash in the bank: type='payment' only (excludes credit_memos entirely).
    // Voided = never settled → 0.
    // Refunded (full): if QB Write Check confirmed (check_txn_id) → 0 (in and out); else → +amount (still in bank).
    // Partial_refunded: applied portion always counts; refunded portion deducted only if QB confirmed.
    const result = await pgConnection.raw(
      `SELECT
         received_at::date AS date,
         SUM(CASE
           WHEN status IN ('applied', 'available', 'partially_applied')
             THEN amount
           WHEN status = 'refunded'
             THEN CASE WHEN qb->>'check_txn_id' IS NOT NULL THEN 0 ELSE amount END
           WHEN status = 'partial_refunded'
             THEN amount - CASE WHEN qb->>'check_txn_id' IS NOT NULL
                                THEN COALESCE((metadata->>'refund_amount')::bigint, 0)
                                ELSE 0 END
           ELSE 0
         END)::bigint AS net_amount,
         COUNT(CASE WHEN status IN ('applied', 'available', 'partially_applied') THEN 1 END)::int AS count
       FROM customer_payment
       WHERE deleted_at IS NULL
         AND type = 'payment'
         AND received_at >= ?
         AND received_at < ?
       GROUP BY received_at::date
       ORDER BY received_at::date`,
      [from, to]
    );

    const days: PaymentSummaryDay[] = (result.rows as any[]).map((r) => ({
      date:
        r.date instanceof Date
          ? r.date.toISOString().slice(0, 10)
          : String(r.date),
      amount: Number(r.net_amount),
      count: Number(r.count),
    }));

    return res.json({ days });
  } catch (err) {
    return res.status(500).json({ error: "Failed to fetch payment summary" });
  }
}

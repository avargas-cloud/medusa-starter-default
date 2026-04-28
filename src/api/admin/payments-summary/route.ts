import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

export interface PaymentSummaryDay {
  date: string;
  amount: number;
  gross_payments: number;
  refunds: number;
  count: number;
}

/**
 * GET /admin/payments-summary?from=ISO&to=ISO
 * Returns daily NET totals of customer_payments in the given range.
 *
 * Cash IN  → type='payment' with status applied/available/partially_applied (+amount)
 * Cash OUT → type='credit_memo' with status='refunded' AND qb.check_txn_id confirmed (−amount)
 *
 * Voided/pending/applied credit_memos contribute 0 (no cash movement).
 * Amounts in cents. count = number of incoming payments only.
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

    const result = await pgConnection.raw(
      `SELECT
         d AS date,
         SUM(net_amount)::bigint      AS net_amount,
         SUM(gross_payments)::bigint  AS gross_payments,
         SUM(refunds)::bigint         AS refunds,
         SUM(payment_count)::int      AS count
       FROM (
         SELECT
           received_at::date AS d,
           CASE WHEN status IN ('applied', 'available', 'partially_applied')
                THEN amount ELSE 0 END AS net_amount,
           CASE WHEN status IN ('applied', 'available', 'partially_applied')
                THEN amount ELSE 0 END AS gross_payments,
           0                           AS refunds,
           CASE WHEN status IN ('applied', 'available', 'partially_applied')
                THEN 1 ELSE 0 END      AS payment_count
         FROM customer_payment
         WHERE deleted_at IS NULL
           AND type = 'payment'
           AND received_at >= ?
           AND received_at < ?

         UNION ALL

         SELECT
           received_at::date AS d,
           CASE WHEN status = 'refunded' AND qb->>'check_txn_id' IS NOT NULL
                THEN -COALESCE((metadata->>'refund_amount')::numeric, amount) ELSE 0 END AS net_amount,
           0                            AS gross_payments,
           CASE WHEN status = 'refunded' AND qb->>'check_txn_id' IS NOT NULL
                THEN COALESCE((metadata->>'refund_amount')::numeric, amount) ELSE 0 END  AS refunds,
           0                            AS payment_count
         FROM customer_payment
         WHERE deleted_at IS NULL
           AND type = 'credit_memo'
           AND received_at >= ?
           AND received_at < ?
       ) sub
       GROUP BY d
       HAVING SUM(net_amount) <> 0 OR SUM(payment_count) > 0
       ORDER BY d`,
      [from, to, from, to]
    );

    const days: PaymentSummaryDay[] = (result.rows as any[]).map((r) => ({
      date:
        r.date instanceof Date
          ? r.date.toISOString().slice(0, 10)
          : String(r.date),
      amount: Number(r.net_amount),
      gross_payments: Number(r.gross_payments),
      refunds: Number(r.refunds),
      count: Number(r.count),
    }));

    return res.json({ days });
  } catch (err) {
    return res.status(500).json({ error: "Failed to fetch payment summary" });
  }
}

import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

import { etDateString } from "../../../lib/finance/batch-day";

export interface PaymentSummaryDay {
  date: string;
  amount: number;
  gross_payments: number;
  refunds: number;
  count: number;
}

/**
 * GET /admin/payments-summary?from=ISO&to=ISO[&mode=payment|batch]
 * Returns daily NET totals of customer_payments in the given range.
 *
 * Cash IN  → type='payment' unless voided (+amount). Day bucket depends on mode:
 *   - mode=payment (default): ET date of received_at — matches the payments
 *     list display (the old received_at::date cast used the UTC session
 *     timezone and shifted evening ET payments a day).
 *   - mode=batch: MERCHANT BATCH DAY (batch_day; ET-date fallback for legacy
 *     null rows). Payments after the 18:45 ET cutoff belong to the next day —
 *     matches the processor's deposits.
 *   Both modes FILTER by the same day key (not received_at) so an evening
 *   payment on the last day of the range lands inside its bucket.
 * Cash OUT → refund records only after QB Write Check is confirmed
 *            (−refund_amount), bucketed on the ET date of the confirmation.
 *
 * Requested refunds without a confirmed Write Check contribute 0 (money has not left).
 * Amounts in cents. count = number of incoming payments only.
 * All day keys are 'YYYY-MM-DD' text (zero-padded → lexical range is chronological).
 */
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const { from, to, mode } = req.query as {
    from?: string;
    to?: string;
    mode?: string;
  };

  if (!from || !to) {
    return res.status(400).json({
      error: "Query params 'from' and 'to' are required (ISO strings)",
    });
  }

  try {
    const pgConnection = req.scope.resolve("__pg_connection__") as any;

    // Dashboard sends local startOfDay/endOfDay instants — reduce them to
    // ET day strings and filter inclusively on the day key.
    const fromDay = etDateString(from);
    const toDay = etDateString(to);

    // Cash-IN day key expression by mode (both are 'YYYY-MM-DD' text).
    const ET_DATE_EXPR = `to_char(received_at AT TIME ZONE 'America/New_York', 'YYYY-MM-DD')`;
    const dayKeyExpr =
      mode === "batch" ? `COALESCE(batch_day, ${ET_DATE_EXPR})` : ET_DATE_EXPR;

    const result = await pgConnection.raw(
      `WITH latest_write_check AS (
         SELECT DISTINCT ON (reference_id)
           reference_id,
           COALESCE(updated_at, created_at) AS confirmed_at
         FROM qb_order_pipeline
         WHERE step = 'write_check'
           AND status = 'confirmed'
         ORDER BY reference_id, COALESCE(updated_at, created_at) DESC
       )
       SELECT
         d AS date,
         SUM(net_amount)::bigint      AS net_amount,
         SUM(gross_payments)::bigint  AS gross_payments,
         SUM(refunds)::bigint         AS refunds,
         SUM(payment_count)::int      AS count
       FROM (
         SELECT
           ${dayKeyExpr} AS d,
           CASE WHEN status <> 'voided'
                THEN amount ELSE 0 END AS net_amount,
           CASE WHEN status <> 'voided'
                THEN amount ELSE 0 END AS gross_payments,
           0                           AS refunds,
           CASE WHEN status <> 'voided'
                THEN 1 ELSE 0 END      AS payment_count
         FROM customer_payment
         WHERE deleted_at IS NULL
           AND type = 'payment'
           AND ${dayKeyExpr} >= ?
           AND ${dayKeyExpr} <= ?

         UNION ALL

         -- Refunds bucket on the day cash actually left the bank: the confirmed
         -- Write Check timestamp (ET date). Legacy rows fall back only after
         -- confirmation.
         SELECT
           to_char(COALESCE(lwc.confirmed_at, (cp.metadata->>'refunded_at')::timestamptz, cp.received_at) AT TIME ZONE 'America/New_York', 'YYYY-MM-DD') AS d,
           -COALESCE((cp.metadata->>'refund_amount')::numeric, cp.amount) AS net_amount,
           0                            AS gross_payments,
           COALESCE((cp.metadata->>'refund_amount')::numeric, cp.amount) AS refunds,
           0                            AS payment_count
         FROM customer_payment cp
         LEFT JOIN latest_write_check lwc ON lwc.reference_id = cp.id
         WHERE cp.deleted_at IS NULL
           AND (
             cp.type = 'refund'
             OR (cp.type <> 'refund' AND cp.status IN ('refunded', 'partial_refunded'))
           )
           AND cp.qb->>'check_txn_id' IS NOT NULL
           AND to_char(COALESCE(lwc.confirmed_at, (cp.metadata->>'refunded_at')::timestamptz, cp.received_at) AT TIME ZONE 'America/New_York', 'YYYY-MM-DD') >= ?
           AND to_char(COALESCE(lwc.confirmed_at, (cp.metadata->>'refunded_at')::timestamptz, cp.received_at) AT TIME ZONE 'America/New_York', 'YYYY-MM-DD') <= ?
       ) sub
       GROUP BY d
       HAVING SUM(net_amount) <> 0 OR SUM(payment_count) > 0
       ORDER BY d`,
      [fromDay, toDay, fromDay, toDay]
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

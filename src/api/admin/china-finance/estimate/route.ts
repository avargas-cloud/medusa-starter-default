/**
 * GET /admin/china-finance/estimate
 *
 * Returns the estimated wire amount for the next payment day.
 * Uses settings: payment_day_of_week + estimate_strategy.
 *
 * Returns:
 *   estimated_cents   — total amount to wire
 *   next_payment_date — the date the wire should be sent
 *   included_bills    — bill IDs included in the estimate
 *   strategy          — which strategy was applied
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

type Knex = { raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: unknown[] }> };

function getNextPaymentDate(paymentDayOfWeek: number): Date {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayDow = today.getDay();
  let daysUntil = paymentDayOfWeek - todayDow;
  if (daysUntil <= 0) daysUntil += 7;
  const next = new Date(today);
  next.setDate(today.getDate() + daysUntil);
  return next;
}

export const GET = async (
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) => {
  const knex = (req.scope as unknown as { resolve: (k: string) => unknown })
    .resolve("__pg_connection__") as Knex;

  const { rows: settings } = await knex.raw(
    `SELECT payment_day_of_week, estimate_strategy FROM china_finance_settings WHERE id = 'singleton'`
  ) as { rows: [{ payment_day_of_week: number; estimate_strategy: string }] };

  const paymentDow = settings[0]?.payment_day_of_week ?? 1;
  const strategy = settings[0]?.estimate_strategy ?? "due_before_next_payment";

  const nextPayment = getNextPaymentDate(paymentDow);
  const nextPaymentStr = nextPayment.toISOString().slice(0, 10);

  const today = new Date().toISOString().slice(0, 10);

  let dueCutoff: string;
  if (strategy === "past_due_only") {
    dueCutoff = today;
  } else {
    // due_before_next_payment: include bills due before next payment day
    dueCutoff = nextPaymentStr;
  }

  const { rows: bills } = await knex.raw(
    `WITH paid AS (
       SELECT bill_id, SUM(applied_cents)::integer AS paid_cents
       FROM china_wire_transfer_application
       GROUP BY bill_id
     )
     SELECT
       cfb.id,
       cfb.amount_cents,
       GREATEST(cfb.amount_cents - COALESCE(paid.paid_cents, 0), 0) AS bill_balance_cents,
       cfb.due_date,
       cfb.invoice_number,
       cfb.po_number,
       cfb.document_type
     FROM china_finance_bill cfb
     LEFT JOIN paid ON paid.bill_id = cfb.id
     WHERE GREATEST(cfb.amount_cents - COALESCE(paid.paid_cents, 0), 0) > 0
       AND due_date IS NOT NULL
       AND due_date <= ?
     ORDER BY cfb.sort_order ASC`,
    [dueCutoff]
  ) as { rows: Array<{ id: string; amount_cents: number; bill_balance_cents: number; due_date: string; invoice_number: string | null; po_number: string | null; document_type: string }> };

  const estimated_cents = bills.reduce((sum, b) => sum + b.bill_balance_cents, 0);

  return res.json({
    estimated_cents,
    next_payment_date: nextPaymentStr,
    included_bills: bills,
    strategy,
    payment_day_of_week: paymentDow,
  });
};

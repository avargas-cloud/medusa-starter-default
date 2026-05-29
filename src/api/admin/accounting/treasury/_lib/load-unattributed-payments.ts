/**
 * load-unattributed-payments.ts
 *
 * Surfaces real cash received on a day that is NOT (fully) attributed to an
 * order/invoice — i.e. a customer_payment of type 'payment' whose non-voided
 * PaymentApplications don't cover its full amount. These payments DO count in
 * the day's net cash (so they land in Operating with $0 revenue/COGS) but the
 * sale behind them is invisible until someone links them. The Treasury page
 * lists them so staff can act.
 *
 * Anchored on customer_payment.received_at (same day boundary as the rest of
 * Treasury). Credit-memo redemptions are excluded (not new cash). Refunds are
 * excluded (type <> 'payment').
 */

export interface UnattributedPayment {
  payment_id: string;
  display_id: number | null;
  customer_id: string | null;
  amount_cents: number;
  applied_cents: number;
  unapplied_cents: number;
  method: string | null;
  source: string | null;
  status: string | null;
  has_locked_order: boolean;
  received_at: string;
}

interface PgConnection {
  raw: (sql: string, params: unknown[]) => Promise<{ rows: any[] }>;
}

interface RawRow {
  payment_id: string;
  display_id: number | string | null;
  customer_id: string | null;
  amount_cents: string | number | null;
  applied_cents: string | number | null;
  unapplied_cents: string | number | null;
  method: string | null;
  source: string | null;
  status: string | null;
  has_locked_order: boolean | null;
  received_at: string | Date | null;
}

function toInt(v: string | number | null | undefined): number {
  if (v === null || v === undefined) return 0;
  const n = typeof v === "string" ? Number(v) : v;
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

export async function loadUnattributedPayments(
  pg: PgConnection,
  dayStart: string,
  dayEnd: string
): Promise<UnattributedPayment[]> {
  const result = await pg.raw(
    `
    WITH applied AS (
      SELECT payment_id, COALESCE(SUM(amount_applied), 0)::numeric AS applied
      FROM payment_application
      WHERE voided_at IS NULL AND deleted_at IS NULL
      GROUP BY payment_id
    )
    SELECT
      cp.id                                          AS payment_id,
      cp.display_id                                  AS display_id,
      cp.customer_id                                 AS customer_id,
      cp.amount                                      AS amount_cents,
      COALESCE(a.applied, 0)                         AS applied_cents,
      (cp.amount - COALESCE(a.applied, 0))           AS unapplied_cents,
      cp.method                                      AS method,
      cp.source                                      AS source,
      cp.status                                      AS status,
      (cp.locked_order_id IS NOT NULL)              AS has_locked_order,
      cp.received_at                                 AS received_at
    FROM customer_payment cp
    LEFT JOIN applied a ON a.payment_id = cp.id
    WHERE cp.deleted_at IS NULL
      AND cp.type = 'payment'
      AND cp.status <> 'voided'
      AND COALESCE(cp.method, '') <> 'credit_memo'
      AND cp.received_at >= ?
      AND cp.received_at <= ?
      AND (cp.amount - COALESCE(a.applied, 0)) > 0
    ORDER BY (cp.amount - COALESCE(a.applied, 0)) DESC
    `,
    [dayStart, dayEnd]
  );

  const rows = (result.rows ?? []) as RawRow[];
  return rows.map((r) => ({
    payment_id: r.payment_id,
    display_id:
      r.display_id === null || r.display_id === undefined
        ? null
        : toInt(r.display_id),
    customer_id: r.customer_id ?? null,
    amount_cents: toInt(r.amount_cents),
    applied_cents: toInt(r.applied_cents),
    unapplied_cents: toInt(r.unapplied_cents),
    method: r.method ?? null,
    source: r.source ?? null,
    status: r.status ?? null,
    has_locked_order: r.has_locked_order === true,
    received_at:
      r.received_at instanceof Date
        ? r.received_at.toISOString()
        : String(r.received_at ?? ""),
  }));
}

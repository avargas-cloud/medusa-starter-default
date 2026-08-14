/**
 * load-unattributed-payments.ts
 *
 * Surfaces real cash received on a day that is NOT (fully) attributed to an
 * order/invoice — i.e. a customer_payment of type 'payment' whose non-voided
 * PaymentApplications don't cover its full amount. These payments DO count in
 * the day's net cash (so they land in Operating with $0 revenue/COGS) but the
 * sale behind them is invisible until someone links them. The Treasury page
 * lists them so staff can act, and blocks that day's "Confirm Transfers"
 * until each one is either linked or explicitly deferred.
 *
 * Anchored on the payment's EFFECTIVE treasury date: `received_at::date`,
 * unless the payment has an entry in `treasury_payment_defer` (the "Exception
 * — defer to next day" action), in which case its most recent
 * `effective_treasury_date` wins. This ONLY moves the UNAPPLIED remainder for
 * Treasury purposes — it never touches `customer_payment.received_at` itself
 * (that still feeds the unrelated QB batch_day/TxnDate mechanism).
 *
 * Credit-memo redemptions are excluded (not new cash). Refunds are excluded
 * (type <> 'payment').
 *
 * Refunded remainders (2026-07-21): a partially/fully refunded payment's
 * refunded portion can never be linked (it's not a sale — the money went back
 * to the customer), so it is SUBTRACTED from the unapplied remainder as soon
 * as the refund is RECORDED (status refunded/partial_refunded) — the BAMS
 * refund already pulled the money from the bank; the QB Write Check is
 * bookkeeping that may lag days behind (user decision 2026-07-21: do NOT gate
 * on `qb->>'check_txn_id'` — the day's Refunds bucket catches up whenever the
 * check confirms, cross-day refunds already have their own warning).
 *
 * "As credit" resolutions (2026-07-21): the accountant can declare a genuine
 * remainder to be customer credit assigned to a bucket
 * (treasury_payment_credit_resolution). A valid, non-stale resolution stops
 * the row from blocking the day's lock; if the live remainder drifts from the
 * resolved snapshot the resolution goes stale and re-blocks.
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
  /** The payment's real capture timestamp — never altered by deferral. */
  original_received_at: string;
  /** Day this payment's unapplied cash currently counts toward for Treasury. */
  effective_treasury_date: string;
  /** How many times "Exception — defer to next day" has been used on this payment. */
  defer_count: number;
  /**
   * True when this deposit points (via metadata.order_id) at an order that is
   * still a DRAFT (an approved estimate not yet converted to a real order).
   * Payments can only be linked to orders/invoices, so these are un-linkable
   * until the estimate is converted — the panel surfaces that as guidance
   * instead of looking like an ordinary missing link.
   */
  estimate_pending: boolean;
  /** The estimate's document number (e.g. "E-2687") when estimate_pending. */
  estimate_doc_no: string | null;
  /** The draft order id to deep-link into the estimate for conversion. */
  estimate_order_id: string | null;
  /** Bucket from a "treat as credit" resolution (null = none). */
  credit_bucket: "china_cogs" | "local_cogs" | "operating" | "reserve" | null;
  /** Remainder snapshot stored when the credit resolution was made. */
  credit_amount_cents: number | null;
  /** True when the live remainder no longer matches the resolved snapshot. */
  credit_stale: boolean;
  /** True when this row still blocks the day's Confirm Transfers. */
  blocking: boolean;
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
  original_received_at: string | Date | null;
  effective_treasury_date: string | Date | null;
  defer_count: string | number | null;
  estimate_pending: boolean | null;
  estimate_doc_no: string | null;
  estimate_order_id: string | null;
  credit_bucket: string | null;
  credit_amount_cents: string | number | null;
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
    ),
    latest_defer AS (
      SELECT DISTINCT ON (payment_id)
        payment_id, effective_treasury_date
      FROM treasury_payment_defer
      ORDER BY payment_id, created_at DESC
    ),
    defer_counts AS (
      SELECT payment_id, COUNT(*)::int AS defer_count
      FROM treasury_payment_defer
      GROUP BY payment_id
    ),
    -- Refunded portion (same COALESCE fallback as the cash CTE's refunds
    -- branch in load-daily-report.ts), netted as soon as the refund is
    -- RECORDED — no check_txn_id gate; the money already left via BAMS.
    refunds AS (
      SELECT cp.id AS payment_id,
        LEAST(GREATEST(COALESCE((cp.metadata->>'refund_amount')::numeric, cp.amount), 0), cp.amount) AS refunded_cents
      FROM customer_payment cp
      WHERE cp.deleted_at IS NULL AND cp.type = 'payment' AND COALESCE(cp.metadata->>'is_commission_credit', '') <> 'true'
        AND cp.status IN ('refunded', 'partial_refunded')
    )
    SELECT
      cp.id                                          AS payment_id,
      cp.display_id                                  AS display_id,
      cp.customer_id                                 AS customer_id,
      cp.amount                                      AS amount_cents,
      COALESCE(a.applied, 0)                         AS applied_cents,
      GREATEST(cp.amount - COALESCE(a.applied, 0) - COALESCE(rf.refunded_cents, 0), 0) AS unapplied_cents,
      tpcr.bucket                                    AS credit_bucket,
      tpcr.amount_cents                              AS credit_amount_cents,
      cp.method                                      AS method,
      cp.source                                      AS source,
      cp.status                                      AS status,
      (cp.locked_order_id IS NOT NULL)              AS has_locked_order,
      cp.received_at                                 AS original_received_at,
      COALESCE(ld.effective_treasury_date, cp.received_at::date) AS effective_treasury_date,
      COALESCE(dc.defer_count, 0)                    AS defer_count,
      -- Estimate-deposit guidance: the referenced order is still a draft (an
      -- approved estimate not yet converted → payment can't be linked yet).
      COALESCE(mo.is_draft_order = true OR mo.status = 'draft', false) AS estimate_pending,
      CASE WHEN COALESCE(mo.is_draft_order = true OR mo.status = 'draft', false)
           THEN cp.metadata->>'order_document_number' ELSE NULL END AS estimate_doc_no,
      CASE WHEN COALESCE(mo.is_draft_order = true OR mo.status = 'draft', false)
           THEN cp.metadata->>'order_id' ELSE NULL END AS estimate_order_id
    FROM customer_payment cp
    LEFT JOIN applied a ON a.payment_id = cp.id
    LEFT JOIN latest_defer ld ON ld.payment_id = cp.id
    LEFT JOIN defer_counts dc ON dc.payment_id = cp.id
    LEFT JOIN refunds rf ON rf.payment_id = cp.id
    LEFT JOIN treasury_payment_credit_resolution tpcr ON tpcr.payment_id = cp.id
    LEFT JOIN "order" mo ON mo.id = cp.metadata->>'order_id' AND mo.deleted_at IS NULL
    WHERE cp.deleted_at IS NULL
      AND cp.type = 'payment' AND COALESCE(cp.metadata->>'is_commission_credit', '') <> 'true'
      AND cp.status <> 'voided'
      AND COALESCE(cp.method, '') <> 'credit_memo'
      AND COALESCE(ld.effective_treasury_date, cp.received_at::date) >= ?::date
      AND COALESCE(ld.effective_treasury_date, cp.received_at::date) <= ?::date
      AND GREATEST(cp.amount - COALESCE(a.applied, 0) - COALESCE(rf.refunded_cents, 0), 0) > 0
    ORDER BY GREATEST(cp.amount - COALESCE(a.applied, 0) - COALESCE(rf.refunded_cents, 0), 0) DESC
    `,
    [dayStart, dayEnd]
  );

  const rows = (result.rows ?? []) as RawRow[];
  return rows.map((r) => {
    const unapplied = toInt(r.unapplied_cents);
    const creditBucket =
      (r.credit_bucket as UnattributedPayment["credit_bucket"]) ?? null;
    const creditAmount =
      r.credit_amount_cents === null || r.credit_amount_cents === undefined
        ? null
        : toInt(r.credit_amount_cents);
    // A resolution only "covers" the row while the live remainder still equals
    // the snapshot it was made against — any drift re-blocks (stale).
    const creditStale = creditBucket !== null && creditAmount !== unapplied;
    return mapRow(r, unapplied, creditBucket, creditAmount, creditStale);
  });
}

function mapRow(
  r: RawRow,
  unapplied: number,
  creditBucket: UnattributedPayment["credit_bucket"],
  creditAmount: number | null,
  creditStale: boolean
): UnattributedPayment {
  return {
    payment_id: r.payment_id,
    display_id:
      r.display_id === null || r.display_id === undefined
        ? null
        : toInt(r.display_id),
    customer_id: r.customer_id ?? null,
    amount_cents: toInt(r.amount_cents),
    applied_cents: toInt(r.applied_cents),
    unapplied_cents: unapplied,
    method: r.method ?? null,
    source: r.source ?? null,
    status: r.status ?? null,
    has_locked_order: r.has_locked_order === true,
    original_received_at:
      r.original_received_at instanceof Date
        ? r.original_received_at.toISOString()
        : String(r.original_received_at ?? ""),
    effective_treasury_date:
      r.effective_treasury_date instanceof Date
        ? r.effective_treasury_date.toISOString().slice(0, 10)
        : String(r.effective_treasury_date ?? ""),
    defer_count: toInt(r.defer_count),
    estimate_pending: r.estimate_pending === true,
    estimate_doc_no: r.estimate_doc_no ?? null,
    estimate_order_id: r.estimate_order_id ?? null,
    credit_bucket: creditBucket,
    credit_amount_cents: creditAmount,
    credit_stale: creditStale,
    blocking: !(creditBucket !== null && !creditStale),
  };
}

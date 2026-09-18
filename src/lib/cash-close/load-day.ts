/**
 * Cash Close — SQL loaders for business day `D` (ET).
 *
 * Every loader here is a thin, parameterized (`?`) read against the raw
 * tables (plan cash-close-20260918). Nothing here classifies or totals
 * anything — that is `classify.ts`/`totals.ts`'s job, kept pure so it can be
 * unit-tested with fixtures instead of a live database. Money columns are
 * cast `::float8` (double precision) in SQL, not `::bigint` — these are
 * cents, always well inside the 53-bit safe-integer range, and casting here
 * means the driver hands back a JS `number` directly instead of a
 * bigint-as-string that every caller would otherwise have to re-`Number()`.
 * (2026-08-07: POS money columns are cents, `order` money is dollars.)
 */

/** Minimal structural view of the MikroORM/knex raw connection — `?`
 * placeholders, `.raw(sql, params).rows`. Matches `PinConn` in
 * `lib/pos/verify-supervisor-pin.ts` but adds `transaction`, which that
 * helper doesn't need. */
export interface Knexish {
  raw<T = unknown>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  transaction<R>(fn: (trx: Knexish) => Promise<R>): Promise<R>;
}

export interface RawPaymentApplication {
  invoice_id: string | null;
  invoice_number: string | null;
  /** YYYY-MM-DD (ET) — resolved here, not in `classify.ts`, so bucketing
   * there stays a pure string comparison with no timezone logic. */
  invoice_issued_day: string | null;
  order_id: string | null;
  order_display_id: number | null;
  amount_applied_cents: number;
  applied_at: string;
}

export interface RawPayment {
  payment_id: string;
  display_id: number;
  received_at: string;
  customer_id: string;
  customer_name: string;
  customer_contact: string | null;
  method: string;
  card_brand: string | null;
  type: "payment" | "credit_memo";
  amount_cents: number;
  surcharge_cents: number;
  metadata: Record<string, unknown> | null;
  /** Order the payment is linked to (locked_order_id, or metadata.order_id
   * when unlocked — a deposit taken before checkout lock). Null if neither
   * resolves. */
  linked_order_id: string | null;
  linked_order_display_id: number | null;
  linked_order_is_draft: boolean | null;
  applications: RawPaymentApplication[];
}

export interface RawInvoiceApplication {
  payment_id: string;
  payment_display_id: number;
  payment_type: "payment" | "credit_memo";
  /** YYYY-MM-DD (ET) the payment was received on. */
  payment_day: string;
  amount_applied_cents: number;
}

export interface RawInvoice {
  invoice_id: string;
  invoice_number: string;
  customer_name: string;
  total_cents: number;
  applications: RawInvoiceApplication[];
}

export interface RawCreditMemo {
  total_cents: number;
  status: string;
}

export interface RawRefund {
  payment_id: string;
  display_id: number;
  customer_name: string;
  amount_cents: number;
  method: string;
  card_brand: string | null;
  /** Set when the refund traces back to a store-credit CM via
   * `metadata.refund_notes` ("Triggered by CM CM-1169 completion"). */
  credit_memo_number: string | null;
}

export interface RawOrderEstimateAgg {
  orders_issued_count: number;
  orders_issued_cents: number;
  estimates_issued_count: number;
  estimates_issued_cents: number;
}

export interface StoredCashClose {
  id: string;
  number: string;
  business_day: string;
  balanced: boolean;
  snapshot: unknown;
  totals: unknown;
  created_by: string;
  created_by_name: string | null;
  created_at: string;
  superseded_by: string | null;
}

const CUSTOMER_NAME_SQL = `COALESCE(NULLIF(c.company_name,''), TRIM(CONCAT_WS(' ', c.first_name, c.last_name)))`;

async function withDefaultName<T extends { customer_name: string | null }>(
  rows: T[]
): Promise<Array<Omit<T, "customer_name"> & { customer_name: string }>> {
  return rows.map((r) => ({ ...r, customer_name: r.customer_name ?? "" }));
}

export async function loadPaymentsForDay(
  knex: Knexish,
  day: string
): Promise<RawPayment[]> {
  const { rows } = await knex.raw<RawPayment & { customer_name: string | null }>(
    `SELECT
        cp.id AS payment_id, cp.display_id, cp.received_at, cp.customer_id,
        ${CUSTOMER_NAME_SQL} AS customer_name,
        CASE WHEN NULLIF(c.company_name,'') IS NOT NULL
               AND TRIM(CONCAT_WS(' ', c.first_name, c.last_name)) NOT IN ('', c.company_name)
             THEN TRIM(CONCAT_WS(' ', c.first_name, c.last_name)) END AS customer_contact,
        cp.method, cp.card_brand, cp.type,
        cp.amount::float8 AS amount_cents,
        COALESCE(cp.surcharge_cents, 0)::float8 AS surcharge_cents,
        cp.metadata,
        lo.id AS linked_order_id, lo.display_id AS linked_order_display_id,
        lo.is_draft_order AS linked_order_is_draft,
        COALESCE(
          jsonb_agg(
            jsonb_build_object(
              'invoice_id', pa.invoice_id, 'invoice_number', pa.invoice_number,
              'invoice_issued_day', to_char(inv.issued_at AT TIME ZONE 'America/New_York', 'YYYY-MM-DD'),
              'order_id', pa.order_id, 'order_display_id', ao.display_id,
              'amount_applied_cents', pa.amount_applied::float8, 'applied_at', pa.applied_at
            ) ORDER BY pa.applied_at
          ) FILTER (WHERE pa.id IS NOT NULL), '[]'::jsonb
        ) AS applications
      FROM customer_payment cp
      LEFT JOIN customer c ON c.id = cp.customer_id
      LEFT JOIN "order" lo
        ON lo.id = COALESCE(cp.locked_order_id, cp.metadata->>'order_id') AND lo.deleted_at IS NULL
      LEFT JOIN payment_application pa
        ON pa.payment_id = cp.id AND pa.voided_at IS NULL AND pa.deleted_at IS NULL
      LEFT JOIN pos_invoice inv ON inv.id = pa.invoice_id
      LEFT JOIN "order" ao ON ao.id = pa.order_id AND ao.deleted_at IS NULL
      WHERE cp.deleted_at IS NULL AND cp.status <> 'voided'
        AND (cp.received_at AT TIME ZONE 'America/New_York')::date = ?
      GROUP BY cp.id, c.id, lo.id
      ORDER BY cp.display_id`,
    [day]
  );
  return withDefaultName(rows.map((r) => ({ ...r, applications: r.applications ?? [] })));
}

export async function loadInvoicesForDay(
  knex: Knexish,
  day: string
): Promise<RawInvoice[]> {
  const { rows } = await knex.raw<RawInvoice & { customer_name: string | null }>(
    `SELECT
        i.id AS invoice_id, i.invoice_number,
        ${CUSTOMER_NAME_SQL} AS customer_name,
        i.total::float8 AS total_cents,
        COALESCE(
          jsonb_agg(
            jsonb_build_object(
              'payment_id', cp.id, 'payment_display_id', cp.display_id, 'payment_type', cp.type,
              'payment_day', to_char(cp.received_at AT TIME ZONE 'America/New_York', 'YYYY-MM-DD'),
              'amount_applied_cents', pa.amount_applied::float8
            ) ORDER BY pa.applied_at
          ) FILTER (WHERE pa.id IS NOT NULL AND cp.id IS NOT NULL
                      AND cp.status <> 'voided' AND cp.deleted_at IS NULL), '[]'::jsonb
        ) AS applications
      FROM pos_invoice i
      LEFT JOIN customer c ON c.id = i.customer_id
      LEFT JOIN payment_application pa
        ON pa.invoice_id = i.id AND pa.voided_at IS NULL AND pa.deleted_at IS NULL
      LEFT JOIN customer_payment cp ON cp.id = pa.payment_id
      WHERE i.deleted_at IS NULL AND i.status <> 'voided' AND i.voided_at IS NULL
        AND (i.issued_at AT TIME ZONE 'America/New_York')::date = ?
      GROUP BY i.id, c.id
      ORDER BY i.invoice_number`,
    [day]
  );
  return withDefaultName(rows.map((r) => ({ ...r, applications: r.applications ?? [] })));
}

export async function loadCreditMemosForDay(
  knex: Knexish,
  day: string
): Promise<RawCreditMemo[]> {
  const { rows } = await knex.raw<RawCreditMemo>(
    `SELECT total::float8 AS total_cents, status
       FROM pos_credit_memo
      WHERE deleted_at IS NULL AND status <> 'voided' AND voided_at IS NULL
        AND (completed_at AT TIME ZONE 'America/New_York')::date = ?`,
    [day]
  );
  return rows;
}

/** `credit_memo_number` extracted from `metadata.refund_notes` — the only
 * place the refund's originating CM is named ("Triggered by CM CM-1169
 * completion"). // ATAJO: a refund_notes rewording breaks this parse; the
 * refund is still counted correctly, only the CM cross-reference is lost. */
function creditMemoNumberFromNotes(notes: unknown): string | null {
  if (typeof notes !== "string") return null;
  return /\bCM-\d+\b/.exec(notes)?.[0] ?? null;
}

export async function loadRefundsForDay(
  knex: Knexish,
  day: string
): Promise<RawRefund[]> {
  const { rows } = await knex.raw<
    RawRefund & { customer_name: string | null; refund_notes: string | null }
  >(
    `SELECT
        cp.id AS payment_id, cp.display_id,
        ${CUSTOMER_NAME_SQL} AS customer_name,
        COALESCE((cp.metadata->>'refund_amount')::float8, 0) AS amount_cents,
        cp.method, cp.card_brand, cp.metadata->>'refund_notes' AS refund_notes
      FROM customer_payment cp
      LEFT JOIN customer c ON c.id = cp.customer_id
      WHERE cp.deleted_at IS NULL AND cp.status IN ('refunded', 'partial_refunded')
        AND COALESCE(
              cp.metadata->>'refund_txn_date',
              to_char((cp.metadata->>'refunded_at')::timestamptz AT TIME ZONE 'America/New_York', 'YYYY-MM-DD')
            ) = ?
      ORDER BY cp.display_id`,
    [day]
  );
  return withDefaultName(
    rows.map((r) => ({ ...r, credit_memo_number: creditMemoNumberFromNotes(r.refund_notes) }))
  );
}

export async function loadOrderEstimateAgg(
  knex: Knexish,
  day: string
): Promise<RawOrderEstimateAgg> {
  const { rows } = await knex.raw<RawOrderEstimateAgg>(
    `SELECT
        count(*) FILTER (WHERE NOT o.is_draft_order)::int AS orders_issued_count,
        COALESCE(sum(ROUND(latest.total * 100)) FILTER (WHERE NOT o.is_draft_order), 0)::float8 AS orders_issued_cents,
        count(*) FILTER (WHERE o.is_draft_order)::int AS estimates_issued_count,
        COALESCE(sum(ROUND(latest.total * 100)) FILTER (WHERE o.is_draft_order), 0)::float8 AS estimates_issued_cents
      FROM "order" o
      JOIN LATERAL (
        SELECT (s.totals->>'current_order_total')::numeric AS total
          FROM order_summary s
         WHERE s.order_id = o.id AND s.deleted_at IS NULL
         ORDER BY s.version DESC LIMIT 1
      ) latest ON true
      WHERE o.deleted_at IS NULL AND (o.created_at AT TIME ZONE 'America/New_York')::date = ?`,
    [day]
  );
  return (
    rows[0] ?? {
      orders_issued_count: 0,
      orders_issued_cents: 0,
      estimates_issued_count: 0,
      estimates_issued_cents: 0,
    }
  );
}

export async function loadExistingClosesForDay(
  knex: Knexish,
  day: string
): Promise<StoredCashClose[]> {
  const { rows } = await knex.raw<StoredCashClose>(
    `SELECT id, number, business_day::text AS business_day, balanced, snapshot, totals,
            created_by, created_by_name, created_at, superseded_by
       FROM pos_cash_close
      WHERE business_day = ?
      ORDER BY created_at DESC`,
    [day]
  );
  return rows;
}

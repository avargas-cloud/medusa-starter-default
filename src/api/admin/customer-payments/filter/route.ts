import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

const PAYMENT_STATUSES = new Set([
  "available",
  "partially_applied",
  "applied",
  "voided",
  "refunded",
  "partial_refunded",
]);

type DateBasis = "batch" | "payment" | "union";

type PaymentListDbRow = {
  id: string;
  display_id: number | null;
  customer_id: string;
  source: string;
  type: string;
  amount: string | number;
  currency: string;
  method: string;
  reference: string | null;
  status: string;
  notes: string | null;
  received_at: string;
  batch_day: string | null;
  created_at: string;
  metadata: Record<string, unknown> | null;
  qb: Record<string, unknown> | null;
  amount_applied: string | number;
  available_balance: string | number;
  applications: Array<Record<string, unknown>>;
  customer: Record<string, unknown> | null;
};

type SqlClient = {
  raw: (
    sql: string,
    bindings?: unknown[]
  ) => Promise<{ rows?: PaymentListDbRow[] }>;
};

function readQueryString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function parseRange(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const ms = Number(value);
  if (Number.isFinite(ms)) {
    return ms > 0 ? new Date(ms).toISOString() : null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function parseDay(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed : null;
}

function parseDateBasis(value: unknown): DateBasis {
  return value === "payment" || value === "union" ? value : "batch";
}

function buildDatePredicate(
  basis: DateBasis,
  from: string | null,
  to: string | null,
  fromDay: string | null,
  toDay: string | null,
  bindings: unknown[]
): string {
  const paymentParts: string[] = [];
  const paymentBindings: unknown[] = [];
  if (from) {
    paymentParts.push("cp.received_at >= ?::timestamptz");
    paymentBindings.push(from);
  }
  if (to) {
    paymentParts.push("cp.received_at <= ?::timestamptz");
    paymentBindings.push(to);
  }

  const batchKey =
    "COALESCE(NULLIF(cp.batch_day, ''), TO_CHAR(cp.received_at AT TIME ZONE 'America/New_York', 'YYYY-MM-DD'))";
  const batchParts: string[] = [];
  const batchBindings: unknown[] = [];
  if (fromDay) {
    batchParts.push(`${batchKey} >= ?`);
    batchBindings.push(fromDay);
  }
  if (toDay) {
    batchParts.push(`${batchKey} <= ?`);
    batchBindings.push(toDay);
  }

  const paymentPredicate = paymentParts.length
    ? `(${paymentParts.join(" AND ")})`
    : "TRUE";
  const batchPredicate = batchParts.length
    ? `(${batchParts.join(" AND ")})`
    : "TRUE";

  if (basis === "payment") {
    bindings.push(...paymentBindings);
    return paymentPredicate;
  }
  if (basis === "union") {
    bindings.push(...paymentBindings, ...batchBindings);
    return `(${paymentPredicate} OR ${batchPredicate})`;
  }
  bindings.push(...batchBindings);
  return batchPredicate;
}

/**
 * Exact compact projection for the POS Payments list and print report.
 */
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const query = readQueryString(req.query.q).toLowerCase();
  const queryDigits = query.replace(/\D/g, "");
  const requestedStatus = readQueryString(req.query.status);
  const status =
    requestedStatus === "unlinked" || PAYMENT_STATUSES.has(requestedStatus)
      ? requestedStatus
      : "all";
  const dateBasis = parseDateBasis(req.query.dateBasis);
  const from = parseRange(req.query.from);
  const to = parseRange(req.query.to);
  const fromDay = parseDay(req.query.fromDay);
  const toDay = parseDay(req.query.toDay);

  const filters = ["cp.deleted_at IS NULL"];
  const bindings: unknown[] = [];

  if (query) {
    const searchPredicates = [
      "STRPOS(LOWER(CONCAT_WS(' ', c.first_name, c.last_name)), ?) > 0",
      "STRPOS(LOWER(COALESCE(c.company_name, '')), ?) > 0",
      "STRPOS(LOWER(COALESCE(c.email, '')), ?) > 0",
      "STRPOS(LOWER(COALESCE(cp.reference, '')), ?) > 0",
      "STRPOS(COALESCE(cp.display_id::text, ''), ?) > 0",
    ];
    bindings.push(query, query, query, query, query);
    if (queryDigits) {
      searchPredicates.push(
        "STRPOS(REGEXP_REPLACE(COALESCE(c.phone, ''), '[^0-9]', '', 'g'), ?) > 0"
      );
      bindings.push(queryDigits);
    }
    filters.push(`(${searchPredicates.join(" OR ")})`);
  } else if (status === "unlinked") {
    filters.push(
      "cp.type IN ('payment', 'credit_memo')",
      "cp.status NOT IN ('voided', 'refunded', 'partial_refunded')",
      "cp.source <> 'web'",
      "cp.amount - COALESCE(app.active_total, 0) > 0.5"
    );
  } else {
    filters.push(
      buildDatePredicate(
        dateBasis,
        from,
        to,
        fromDay,
        toDay,
        bindings
      )
    );
    if (PAYMENT_STATUSES.has(status)) {
      filters.push("cp.status = ?");
      bindings.push(status);
    }
  }

  const pg = (
    req.scope as unknown as { resolve: (key: string) => unknown }
  ).resolve("__pg_connection__") as SqlClient;

  try {
    const result = await pg.raw(
      `
        WITH application_data AS (
          SELECT
            pa.payment_id,
            COALESCE(
              SUM(pa.amount_applied) FILTER (WHERE pa.voided_at IS NULL),
              0
            ) AS active_total,
            jsonb_agg(
              jsonb_strip_nulls(jsonb_build_object(
                'id', pa.id,
                'invoice_id', pa.invoice_id,
                'invoice_number', pa.invoice_number,
                'order_id', pa.order_id,
                'amount_applied', pa.amount_applied,
                'applied_at', pa.applied_at,
                'applied_by', pa.applied_by,
                'voided_at', pa.voided_at,
                'void_reason', pa.void_reason,
                'metadata', pa.metadata
              ))
              ORDER BY pa.created_at
            ) AS applications
          FROM payment_application pa
          WHERE pa.deleted_at IS NULL
          GROUP BY pa.payment_id
        )
        SELECT
          cp.id,
          cp.display_id,
          cp.customer_id,
          cp.source,
          cp.type,
          cp.amount,
          cp.currency,
          cp.method,
          cp.reference,
          cp.status,
          cp.notes,
          cp.received_at,
          cp.batch_day,
          cp.created_at,
          jsonb_strip_nulls(jsonb_build_object(
            'invoices_affected_friendly', cp.metadata->'invoices_affected_friendly',
            'refund_amount', cp.metadata->'refund_amount',
            'dejavoo_cardholder_charged_cents', cp.metadata->'dejavoo_cardholder_charged_cents',
            'bams_total_charged_cents', cp.metadata->'bams_total_charged_cents',
            'transaction_type', cp.metadata->'transaction_type',
            'qb_sync_status', cp.metadata->'qb_sync_status',
            'qb_txn_id', cp.metadata->'qb_txn_id',
            'is_sales_receipt_payment', cp.metadata->'is_sales_receipt_payment'
          )) AS metadata,
          cp.qb,
          COALESCE(app.active_total, 0) AS amount_applied,
          GREATEST(0, cp.amount - COALESCE(app.active_total, 0)) AS available_balance,
          COALESCE(app.applications, '[]'::jsonb) AS applications,
          CASE WHEN c.id IS NULL THEN NULL ELSE jsonb_build_object(
            'id', c.id,
            'first_name', c.first_name,
            'last_name', c.last_name,
            'email', c.email,
            'phone', c.phone,
            'company_name', c.company_name
          ) END AS customer
        FROM customer_payment cp
        LEFT JOIN application_data app ON app.payment_id = cp.id
        LEFT JOIN customer c
          ON c.id = cp.customer_id
         AND c.deleted_at IS NULL
        WHERE ${filters.join(" AND ")}
        ORDER BY cp.received_at DESC
      `,
      bindings
    );

    const payments = (result.rows ?? []).map((row) => ({
      ...row,
      amount: Number(row.amount),
      amount_applied: Number(row.amount_applied),
      available_balance: Number(row.available_balance),
    }));
    return res.json({ payments, count: payments.length });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown payment filter error";
    return res.status(500).json({
      error: "payment_filter_failed",
      message,
      payments: [],
      count: 0,
    });
  }
}

export const AUTHENTICATE = ["user"];

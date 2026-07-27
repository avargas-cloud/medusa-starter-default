import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

type PaymentCountsDbRow = {
  all_count: string | number;
  available_count: string | number;
  partially_applied_count: string | number;
  applied_count: string | number;
  voided_count: string | number;
  refunded_count: string | number;
  partial_refunded_count: string | number;
  unlinked_count: string | number;
};

type SqlClient = {
  raw: (
    sql: string,
    bindings?: unknown[]
  ) => Promise<{ rows?: PaymentCountsDbRow[] }>;
};

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

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const dateBasis = req.query.dateBasis === "payment" ? "payment" : "batch";
  const from = parseRange(req.query.from);
  const to = parseRange(req.query.to);
  const fromDay = parseDay(req.query.fromDay);
  const toDay = parseDay(req.query.toDay);
  const bindings: unknown[] = [];

  const dateParts: string[] = [];
  if (dateBasis === "payment") {
    if (from) {
      dateParts.push("cp.received_at >= ?::timestamptz");
      bindings.push(from);
    }
    if (to) {
      dateParts.push("cp.received_at <= ?::timestamptz");
      bindings.push(to);
    }
  } else {
    const batchKey =
      "COALESCE(NULLIF(cp.batch_day, ''), TO_CHAR(cp.received_at AT TIME ZONE 'America/New_York', 'YYYY-MM-DD'))";
    if (fromDay) {
      dateParts.push(`${batchKey} >= ?`);
      bindings.push(fromDay);
    }
    if (toDay) {
      dateParts.push(`${batchKey} <= ?`);
      bindings.push(toDay);
    }
  }
  const datePredicate = dateParts.length
    ? dateParts.join(" AND ")
    : "TRUE";

  const pg = (
    req.scope as unknown as { resolve: (key: string) => unknown }
  ).resolve("__pg_connection__") as SqlClient;

  try {
    const result = await pg.raw(
      `
        WITH application_totals AS (
          SELECT
            pa.payment_id,
            COALESCE(
              SUM(pa.amount_applied) FILTER (WHERE pa.voided_at IS NULL),
              0
            ) AS active_total
          FROM payment_application pa
          WHERE pa.deleted_at IS NULL
          GROUP BY pa.payment_id
        ),
        payment_scope AS (
          SELECT
            cp.status,
            (${datePredicate}) AS in_range,
            (
              cp.type IN ('payment', 'credit_memo')
              AND cp.status NOT IN ('voided', 'refunded', 'partial_refunded')
              AND cp.source <> 'web'
              AND cp.amount - COALESCE(app.active_total, 0) > 0.5
            ) AS is_unlinked
          FROM customer_payment cp
          LEFT JOIN application_totals app ON app.payment_id = cp.id
          WHERE cp.deleted_at IS NULL
        )
        SELECT
          COUNT(*) FILTER (WHERE in_range) AS all_count,
          COUNT(*) FILTER (WHERE in_range AND status = 'available') AS available_count,
          COUNT(*) FILTER (WHERE in_range AND status = 'partially_applied') AS partially_applied_count,
          COUNT(*) FILTER (WHERE in_range AND status = 'applied') AS applied_count,
          COUNT(*) FILTER (WHERE in_range AND status = 'voided') AS voided_count,
          COUNT(*) FILTER (WHERE in_range AND status = 'refunded') AS refunded_count,
          COUNT(*) FILTER (WHERE in_range AND status = 'partial_refunded') AS partial_refunded_count,
          COUNT(*) FILTER (WHERE is_unlinked) AS unlinked_count
        FROM payment_scope
      `,
      bindings
    );

    const row = result.rows?.[0];
    return res.json({
      counts: {
        all: Number(row?.all_count ?? 0),
        available: Number(row?.available_count ?? 0),
        partially_applied: Number(row?.partially_applied_count ?? 0),
        applied: Number(row?.applied_count ?? 0),
        voided: Number(row?.voided_count ?? 0),
        refunded: Number(row?.refunded_count ?? 0),
        partial_refunded: Number(row?.partial_refunded_count ?? 0),
      },
      unlinkedCount: Number(row?.unlinked_count ?? 0),
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown payment counts error";
    return res.status(500).json({
      error: "payment_counts_failed",
      message,
    });
  }
}

export const AUTHENTICATE = ["user"];

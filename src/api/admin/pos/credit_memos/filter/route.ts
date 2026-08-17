import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

type SqlClient = {
  raw: (
    sql: string,
    bindings?: unknown[]
  ) => Promise<{ rows?: ReturnListDbRow[] }>;
};

type ReturnListDbRow = {
  id: string;
  credit_memo_number: string | null;
  customer_id: string | null;
  order_id: string | null;
  status: string;
  total: string | number;
  tax: string | number;
  credit_available: string | number | null;
  created_at: string;
  notes: string | null;
  qb_txn_id: string | null;
  qb_ref_number: string | null;
  sales_rep: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
  customer: Record<string, unknown> | null;
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

function readQueryString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Exact list projection for the POS Returns page.
 *
 * Filters and enrichment run in one compact SQL query. The previous UI loaded
 * up to 2,000 fully-hydrated credit memos and then filtered them in the browser,
 * which was both slower and temporarily incomplete beyond the recent 200.
 */
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const from = parseRange(req.query.from);
  const to = parseRange(req.query.to);
  const showVoided = req.query.showVoided === "true";
  const query = readQueryString(req.query.q).toLowerCase();
  const queryDigits = query.replace(/\D/g, "");

  const filters = ["cm.deleted_at IS NULL"];
  const bindings: unknown[] = [];

  if (from) {
    filters.push("cm.created_at >= ?::timestamptz");
    bindings.push(from);
  }
  if (to) {
    filters.push("cm.created_at <= ?::timestamptz");
    bindings.push(to);
  }
  if (!showVoided) {
    filters.push("cm.status <> 'voided'");
  }
  if (query) {
    const searchPredicates = [
      "STRPOS(LOWER(COALESCE(cm.credit_memo_number, '')), ?) > 0",
      "STRPOS(LOWER(COALESCE(cm.order_id, '')), ?) > 0",
      "STRPOS(LOWER(COALESCE(cm.notes, '')), ?) > 0",
      "STRPOS(LOWER(CONCAT_WS(' ', c.first_name, c.last_name)), ?) > 0",
      "STRPOS(LOWER(COALESCE(c.company_name, '')), ?) > 0",
      "STRPOS(LOWER(COALESCE(c.email, '')), ?) > 0",
      "STRPOS(LOWER(COALESCE(c.phone, '')), ?) > 0",
    ];
    bindings.push(query, query, query, query, query, query, query);
    if (queryDigits) {
      searchPredicates.push(
        "STRPOS(REGEXP_REPLACE(COALESCE(c.phone, ''), '[^0-9]', '', 'g'), ?) > 0"
      );
      bindings.push(queryDigits);
    }
    filters.push(`(${searchPredicates.join(" OR ")})`);
  }

  const pg = (
    req.scope as unknown as { resolve: (key: string) => unknown }
  ).resolve("__pg_connection__") as SqlClient;

  try {
    const result = await pg.raw(
      `
        WITH application_totals AS (
          SELECT
            pa.payment_id,
            SUM(pa.amount_applied) AS applied_total
          FROM payment_application pa
          WHERE pa.deleted_at IS NULL
            AND pa.voided_at IS NULL
          GROUP BY pa.payment_id
        ),
        credit_totals AS (
          SELECT
            cp.reference,
            SUM(
              CASE
                WHEN cp.status IN ('available', 'partially_applied')
                  THEN GREATEST(0, cp.amount - COALESCE(app.applied_total, 0))
                ELSE 0
              END
            ) AS credit_available
          FROM customer_payment cp
          LEFT JOIN application_totals app ON app.payment_id = cp.id
          WHERE cp.deleted_at IS NULL
            AND cp.type = 'credit_memo'
          GROUP BY cp.reference
        ),
        qb_refs AS (
          SELECT DISTINCT ON (pipeline.qb_txn_id)
            pipeline.qb_txn_id,
            pipeline.qb_ref_number
          FROM qb_order_pipeline pipeline
          WHERE pipeline.step = 'credit_memo'
            AND pipeline.status = 'confirmed'
            AND pipeline.qb_txn_id IS NOT NULL
          ORDER BY pipeline.qb_txn_id, pipeline.updated_at DESC
        )
        SELECT
          cm.id,
          cm.credit_memo_number,
          cm.customer_id,
          cm.order_id,
          cm.status,
          cm.total,
          cm.tax,
          credit.credit_available,
          cm.created_at,
          cm.notes,
          cm.qb_txn_id,
          qb.qb_ref_number,
          cm.sales_rep,
          jsonb_strip_nulls(jsonb_build_object(
            'sales_rep', cm.metadata->'sales_rep'
          )) AS metadata,
          CASE WHEN c.id IS NULL THEN NULL ELSE jsonb_build_object(
            'first_name', c.first_name,
            'last_name', c.last_name,
            'email', c.email,
            'phone', c.phone,
            'company_name', c.company_name
          ) END AS customer
        FROM pos_credit_memo cm
        LEFT JOIN customer c
          ON c.id = cm.customer_id
         AND c.deleted_at IS NULL
        LEFT JOIN credit_totals credit
          ON credit.reference = cm.credit_memo_number
        LEFT JOIN qb_refs qb
          ON qb.qb_txn_id = cm.qb_txn_id
        WHERE ${filters.join(" AND ")}
        ORDER BY cm.created_at DESC
      `,
      bindings
    );

    const creditMemos = (result.rows ?? []).map((row) => {
      // Same convention as pos_invoice.untaxed_total (subtotal + shipping,
      // i.e. total − tax), so the Returns footer and the Invoices footer sum
      // comparable numbers. Money columns of the POS are CENTS.
      const total = Number(row.total);
      const tax = Number(row.tax ?? 0);
      return {
        ...row,
        total,
        tax,
        untaxed_total:
          Number.isFinite(total) && Number.isFinite(tax) ? total - tax : total,
        credit_available:
          row.credit_available == null ? null : Number(row.credit_available),
      };
    });
    return res.json({
      credit_memos: creditMemos,
      count: creditMemos.length,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown return filter error";
    return res.status(500).json({
      error: "return_filter_failed",
      message,
      credit_memos: [],
      count: 0,
    });
  }
}

export const AUTHENTICATE = ["user"];

import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

/**
 * GET /admin/invoices/counts?from=<isoOrMs>&to=<isoOrMs>&showVoided=true|false
 *
 * Returns the REAL tab counts for the POS /invoices page, computed via SQL
 * directly against pos_invoice + fulfillment + fulfillment_label so even
 * invoices outside the page's 2000-most-recent fetch are counted accurately.
 *
 * "Unfulfilled" mirrors the UI's isInvoiceFulfilled():
 *   - no fulfillment_id            → unfulfilled
 *   - fulfillment.canceled_at set  → unfulfilled
 *   - no shipped_at, no delivered_at, and no fulfillment_label rows → unfulfilled
 *   - otherwise                    → fulfilled
 */

const VOIDED_STATUS = "voided";

export type InvoicesCountsResponse = {
  counts: {
    all: number;
    unpaid: number;
    unfulfilled: number;
  };
  voidedCount: number;
};

function parseRange(v: unknown): string | null {
  if (typeof v !== "string" || v.length === 0) return null;
  const ms = Number(v);
  if (Number.isFinite(ms) && ms > 0) {
    return new Date(ms).toISOString();
  }
  // Assume already ISO; let Postgres parse it.
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const from = parseRange(req.query.from);
  const to = parseRange(req.query.to);
  const showVoided = req.query.showVoided === "true";

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pg = req.scope.resolve("__pg_connection__") as any;

  try {
    // knex's pg.raw uses ? placeholders (positional), not $1/$2.
    const filters: string[] = ["i.deleted_at IS NULL"];
    const params: (string | number)[] = [];
    if (from) {
      params.push(from);
      filters.push(`i.created_at >= ?::timestamptz`);
    }
    if (to) {
      params.push(to);
      filters.push(`i.created_at <= ?::timestamptz`);
    }
    const where = filters.join(" AND ");

    const sql = `
      WITH inv AS (
        SELECT
          i.id,
          i.status,
          i.balance_due,
          i.fulfillment_id,
          f.shipped_at,
          f.delivered_at,
          f.canceled_at,
          EXISTS (
            SELECT 1 FROM fulfillment_label l
            WHERE l.fulfillment_id = i.fulfillment_id
              AND l.deleted_at IS NULL
          ) AS has_tracking
        FROM pos_invoice i
        LEFT JOIN fulfillment f
          ON f.id = i.fulfillment_id AND f.deleted_at IS NULL
        WHERE ${where}
      )
      SELECT
        COUNT(*) FILTER (WHERE status != '${VOIDED_STATUS}')                 AS non_voided,
        COUNT(*) FILTER (
          WHERE status != '${VOIDED_STATUS}' AND balance_due > 0
        )                                                                     AS unpaid,
        COUNT(*) FILTER (
          WHERE status != '${VOIDED_STATUS}' AND (
            fulfillment_id IS NULL
            OR canceled_at IS NOT NULL
            OR (shipped_at IS NULL AND delivered_at IS NULL AND NOT has_tracking)
          )
        )                                                                     AS unfulfilled,
        COUNT(*) FILTER (WHERE status = '${VOIDED_STATUS}')                  AS voided,
        COUNT(*)                                                              AS total
      FROM inv;
    `;

    const result = await pg.raw(sql, params);
    const row = result.rows?.[0] ?? {};
    const nonVoided = Number(row.non_voided ?? 0);
    const unpaid = Number(row.unpaid ?? 0);
    const unfulfilled = Number(row.unfulfilled ?? 0);
    const voided = Number(row.voided ?? 0);
    const total = Number(row.total ?? 0);

    const body: InvoicesCountsResponse = {
      counts: {
        all: showVoided ? total : nonVoided,
        unpaid,
        unfulfilled,
      },
      voidedCount: voided,
    };
    return res.json(body);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return res.status(500).json({ error: "counts_failed", message });
  }
}

export const AUTHENTICATE = ["user"];

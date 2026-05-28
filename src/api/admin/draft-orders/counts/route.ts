import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

export type DraftOrderCountsResponse = {
  visibleCount: number;
  notApprovedCount: number;
  cancelledCount: number;
};

function parseRange(v: unknown): string | null {
  if (typeof v !== "string" || v.length === 0) return null;
  const ms = Number(v);
  if (Number.isFinite(ms) && ms > 0) return new Date(ms).toISOString();
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const from = parseRange(req.query.from);
  const to = parseRange(req.query.to);
  const showNotApproved = req.query.showNotApproved === "true";
  const showCancelled = req.query.showCancelled === "true";

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pg = req.scope.resolve("__pg_connection__") as any;

  try {
    const filters: string[] = [
      "o.deleted_at IS NULL",
      "o.is_draft_order = TRUE",
    ];
    const params: string[] = [];
    if (from) {
      params.push(from);
      filters.push("o.created_at >= ?::timestamptz");
    }
    if (to) {
      params.push(to);
      filters.push("o.created_at <= ?::timestamptz");
    }
    const where = filters.join(" AND ");

    const visibilityFilters: string[] = [];
    if (!showNotApproved) {
      visibilityFilters.push(
        "status_value NOT IN ('Not Approved', 'not_approved')"
      );
    }
    if (!showCancelled) {
      visibilityFilters.push(
        "status_value NOT IN ('Cancelled', 'cancelled', 'Voided', 'voided')"
      );
    }
    const visiblePredicate = visibilityFilters.length
      ? visibilityFilters.join(" AND ")
      : "TRUE";

    const sql = `
      WITH estimates AS (
        SELECT
          COALESCE(o.metadata->>'order_status', o.metadata->>'estimate_status', '') AS status_value
        FROM "order" o
        WHERE ${where}
      )
      SELECT
        COUNT(*) FILTER (WHERE ${visiblePredicate}) AS visible_count,
        COUNT(*) FILTER (WHERE status_value IN ('Not Approved', 'not_approved')) AS not_approved_count,
        COUNT(*) FILTER (WHERE status_value IN ('Cancelled', 'cancelled', 'Voided', 'voided')) AS cancelled_count
      FROM estimates;
    `;

    const result = await pg.raw(sql, params);
    const row = result.rows?.[0] ?? {};
    const body: DraftOrderCountsResponse = {
      visibleCount: Number(row.visible_count ?? 0),
      notApprovedCount: Number(row.not_approved_count ?? 0),
      cancelledCount: Number(row.cancelled_count ?? 0),
    };
    return res.json(body);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return res.status(500).json({ error: "counts_failed", message });
  }
}

export const AUTHENTICATE = ["user"];

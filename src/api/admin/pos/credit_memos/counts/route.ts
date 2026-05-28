import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

export type CreditMemoCountsResponse = {
  visibleCount: number;
  voidedCount: number;
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
  const showVoided = req.query.showVoided === "true";

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pg = req.scope.resolve("__pg_connection__") as any;

  try {
    const filters: string[] = ["deleted_at IS NULL"];
    const params: string[] = [];
    if (from) {
      params.push(from);
      filters.push("created_at >= ?::timestamptz");
    }
    if (to) {
      params.push(to);
      filters.push("created_at <= ?::timestamptz");
    }
    const where = filters.join(" AND ");

    const sql = `
      SELECT
        COUNT(*) FILTER (WHERE status != 'voided') AS non_voided,
        COUNT(*) FILTER (WHERE status = 'voided') AS voided,
        COUNT(*) AS total
      FROM pos_credit_memo
      WHERE ${where};
    `;

    const result = await pg.raw(sql, params);
    const row = result.rows?.[0] ?? {};
    const nonVoided = Number(row.non_voided ?? 0);
    const voided = Number(row.voided ?? 0);
    const total = Number(row.total ?? 0);

    const body: CreditMemoCountsResponse = {
      visibleCount: showVoided ? total : nonVoided,
      voidedCount: voided,
    };
    return res.json(body);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return res.status(500).json({ error: "counts_failed", message });
  }
}

export const AUTHENTICATE = ["user"];

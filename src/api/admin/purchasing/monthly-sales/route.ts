/**
 * GET /admin/purchasing/monthly-sales
 *
 * Returns unit sales per SKU per calendar month from purchasing_sales_history.
 * Primary variants carry an `alts` array with their linked alternatives
 * (sourced from product_alternative table). Alt variants are removed from
 * the top-level list — they only appear nested inside their primary.
 *
 * Response:
 *   { months: string[], business_days: number, rows: MonthlySalesRow[] }
 *   months        — ISO month keys (newest first, derived from actual data, up to 12)
 *   business_days — Mon–Sat days across the full period
 *   rows          — primaries + unlinked variants; each row may have alts[]
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import { withDb } from "../_lib/db";

export interface MonthlySalesRow {
  variant_id: string;
  sku: string;
  product_title: string;
  sales_description: string;
  total_12m: number;
  revenue_12m: number;
  avg_daily: number;
  monthly_units: number[];
  alts: MonthlySalesRow[];
}

/** Count Mon–Sat days between two ISO date strings (inclusive). */
function countBusinessDays(startIso: string, endIso: string): number {
  const start = new Date(startIso + "T00:00:00");
  const end = new Date(endIso + "T00:00:00");
  let count = 0;
  const cur = new Date(start);
  while (cur <= end) {
    if (cur.getDay() !== 0) count++;
    cur.setDate(cur.getDate() + 1);
  }
  return count;
}

/** Last day of a YYYY-MM string → "YYYY-MM-DD" */
function lastDayOfMonth(ym: string): string {
  const parts = ym.split("-");
  const y = parseInt(parts[0]!, 10);
  const m = parseInt(parts[1]!, 10);
  const d = new Date(y, m, 0);
  return `${y}-${String(m).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function makeEmptyRow(variantId: string, monthCount: number): MonthlySalesRow {
  return {
    variant_id: variantId,
    sku: variantId,
    product_title: "",
    sales_description: "",
    total_12m: 0,
    revenue_12m: 0,
    avg_daily: 0,
    monthly_units: new Array(monthCount).fill(0),
    alts: [],
  };
}

export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  return withDb(async (db) => {
    const q = ((req.query as Record<string, string>).q ?? "")
      .trim()
      .toLowerCase();

    // ── 1. Derive available months from actual DB data (newest first, up to 12) ─
    const { rows: monthRows } = await db.query<{ month: string }>(`
      SELECT DISTINCT TO_CHAR(month_date, 'YYYY-MM') AS month
      FROM purchasing_sales_history
      WHERE qty_sold > 0
      ORDER BY month DESC
      LIMIT 12
    `);
    const months = monthRows.map((r) => r.month);
    if (months.length === 0)
      return res.json({ months: [], business_days: 0, rows: [] });

    const oldest = months[months.length - 1] as string;
    const newest = months[0] as string;
    const periodStart = oldest + "-01";
    const periodEnd = lastDayOfMonth(newest);
    const businessDays = countBusinessDays(periodStart, periodEnd);
    const mCount = months.length;

    // ── 2. Load all monthly sales from purchasing_sales_history ──────────────
    const { rows: raw } = await db.query<{
      variant_id: string;
      sku: string;
      product_title: string;
      sales_description: string;
      month: string;
      units: string;
      revenue: string;
    }>(
      `
      SELECT
        psh.variant_id,
        COALESCE(pv.sku, psh.variant_id)                        AS sku,
        COALESCE(p.title, pv.sku, psh.variant_id)               AS product_title,
        COALESCE(pv.metadata->>'sales_description', '')          AS sales_description,
        TO_CHAR(psh.month_date, 'YYYY-MM')                       AS month,
        psh.qty_sold::int                                        AS units,
        psh.revenue::numeric                                     AS revenue
      FROM purchasing_sales_history psh
      LEFT JOIN product_variant pv ON pv.id = psh.variant_id AND pv.deleted_at IS NULL
      LEFT JOIN product p ON p.id = pv.product_id AND p.deleted_at IS NULL
      WHERE psh.month_date BETWEEN $1::date AND (DATE_TRUNC('month', $2::date) + INTERVAL '1 month - 1 day')::date
        AND psh.qty_sold > 0
      ORDER BY sku, month DESC
    `,
      [periodStart, newest + "-01"]
    );

    // ── 3. Pivot into per-variant rows ────────────────────────────────────────
    const variantMap = new Map<string, MonthlySalesRow>();

    for (const r of raw) {
      if (!variantMap.has(r.variant_id)) {
        variantMap.set(r.variant_id, makeEmptyRow(r.variant_id, mCount));
      }
      const row = variantMap.get(r.variant_id)!;
      if (r.sku && r.sku !== r.variant_id) row.sku = r.sku;
      if (r.product_title && r.product_title !== r.variant_id)
        row.product_title = r.product_title;
      if (r.sales_description) row.sales_description = r.sales_description;

      const idx = months.indexOf(r.month);
      if (idx !== -1) {
        const units = parseInt(r.units as unknown as string, 10) || 0;
        const revenue = parseFloat(r.revenue as unknown as string) || 0;
        row.monthly_units[idx] = units;
        row.total_12m += units;
        row.revenue_12m += revenue;
      }
    }

    for (const row of variantMap.values()) {
      row.avg_daily =
        businessDays > 0
          ? Math.round((row.total_12m / businessDays) * 100) / 100
          : 0;
    }

    // ── 4. Load product_alternative links ─────────────────────────────────────
    const { rows: altLinks } = await db.query<{
      primary_variant_id: string;
      alt_variant_id: string;
      primary_sku: string;
      primary_title: string;
    }>(`
      SELECT
        pa.primary_variant_id,
        pa.alt_variant_id,
        COALESCE(pv_p.sku, pa.primary_variant_id) AS primary_sku,
        COALESCE(p_p.title, pv_p.sku, pa.primary_variant_id) AS primary_title
      FROM product_alternative pa
      LEFT JOIN product_variant pv_p ON pv_p.id = pa.primary_variant_id AND pv_p.deleted_at IS NULL
      LEFT JOIN product p_p ON p_p.id = pv_p.product_id AND p_p.deleted_at IS NULL
      WHERE pa.deleted_at IS NULL AND pa.is_active = true
      ORDER BY pa.primary_variant_id, pa.priority
    `);

    // ── 5. Build primary → alts grouping ─────────────────────────────────────
    // altSet: variant_ids that are alternatives of some primary
    const altSet = new Set<string>();
    // primaryMap: primary_variant_id → ordered list of alt_variant_ids
    const primaryMap = new Map<
      string,
      { sku: string; title: string; altIds: string[] }
    >();

    for (const link of altLinks) {
      altSet.add(link.alt_variant_id);
      if (!primaryMap.has(link.primary_variant_id)) {
        primaryMap.set(link.primary_variant_id, {
          sku: link.primary_sku,
          title: link.primary_title,
          altIds: [],
        });
      }
      primaryMap.get(link.primary_variant_id)!.altIds.push(link.alt_variant_id);
    }

    // Ensure primary rows exist in variantMap (even if no own sales)
    for (const [primaryId, meta] of primaryMap.entries()) {
      if (!variantMap.has(primaryId)) {
        const row = makeEmptyRow(primaryId, mCount);
        row.sku = meta.sku;
        row.product_title = meta.title;
        variantMap.set(primaryId, row);
      }
    }

    // Attach alts to primaries
    for (const [primaryId, meta] of primaryMap.entries()) {
      const primaryRow = variantMap.get(primaryId)!;
      primaryRow.alts = meta.altIds
        .map((id) => variantMap.get(id))
        .filter(
          (r): r is MonthlySalesRow => r !== undefined && r.total_12m > 0
        );
    }

    // ── 6. Build top-level list (primaries + unlinked variants) ──────────────
    let rows = Array.from(variantMap.values()).filter((r) => {
      // Exclude pure-alt rows (they appear under their primary)
      if (altSet.has(r.variant_id)) return false;
      // Include if has own sales OR has alts with sales
      return r.total_12m > 0 || r.alts.length > 0;
    });

    // ── 7. Optional text search ───────────────────────────────────────────────
    if (q) {
      rows = rows.filter((r) => {
        const selfMatch =
          r.sku.toLowerCase().includes(q) ||
          r.product_title.toLowerCase().includes(q);
        const altMatch = r.alts.some(
          (a) =>
            a.sku.toLowerCase().includes(q) ||
            a.product_title.toLowerCase().includes(q)
        );
        return selfMatch || altMatch;
      });
    }

    rows.sort((a, b) => b.total_12m - a.total_12m);

    return res.json({ months, business_days: businessDays, rows });
  });
}

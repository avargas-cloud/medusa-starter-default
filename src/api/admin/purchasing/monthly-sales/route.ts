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

import { computeTier0Meta, Tier0Meta } from "../../../../services/purchasing/tier0-window";
import { withDb } from "../_lib/db";

/**
 * Where the Pareto/demand numbers come from for this row:
 *   • self            — primary has ≥12 months of own history; standard ranking.
 *   • alternative_proxy — primary <12 mo own history but at least one alt has ≥12 mo;
 *                        bundle inherits the alt's older quarters.
 *   • partial         — primary <12 mo and no alt covers the gap; weights renormalized.
 *   • none            — no sales recorded for primary or alts.
 */
export type DemandSource =
  | "self"
  | "alternative_proxy"
  | "partial"
  | "none";

export interface MonthlySalesRow {
  variant_id: string;
  sku: string;
  product_title: string;
  sales_description: string;
  total_12m: number;
  revenue_12m: number;
  /** Tier-weighted monthly NET revenue from purchasing_snapshot. Pareto ranking metric. */
  weighted_revenue: number;
  /** Combined weighted revenue: primary + alts. Used for Pareto group thresholds. */
  combined_weighted_revenue: number;
  pareto_rank: number | null;
  abc_class: "A" | "B" | "C" | null;
  xyz_class: "X" | "Y" | "Z" | "N" | null;
  /** Months in the CV series; < MIN_CV_POINTS → xyz_class 'N'. 3-5 = provisional. */
  cv_points: number | null;
  /** Earliest sale date across primary + alts (YYYY-MM-DD); null = never sold. */
  first_sale_date: string | null;
  /** Months of history (primary's own first sale → today). */
  history_months: number;
  data_source: DemandSource;
  avg_daily: number;
  monthly_units: number[];
  /** Per-month NET revenue (parallel to monthly_units, ordered like `months`). */
  monthly_revenue: number[];
  /** Snapshot fields used by the Weighted tooltip to show the breakdown. */
  tier0_30d: number; // units/mo in tier0 window
  sales_q4: number; // raw units, most recent 3 months
  sales_q3: number;
  sales_q2: number;
  sales_q1: number; // raw units, oldest months
  monthly_sales_est: number; // weighted units/mo
  alts: MonthlySalesRow[];
}

export interface MonthlySalesResponse {
  months: string[];
  business_days: number;
  rows: MonthlySalesRow[];
  /** Tier0 metadata — same for the whole response (computed from today's date). */
  tier0_meta: Tier0Meta;
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
    weighted_revenue: 0,
    combined_weighted_revenue: 0,
    pareto_rank: null,
    abc_class: null,
    xyz_class: null,
    cv_points: null,
    first_sale_date: null,
    history_months: 0,
    data_source: "none",
    avg_daily: 0,
    monthly_units: new Array(monthCount).fill(0),
    monthly_revenue: new Array(monthCount).fill(0),
    tier0_30d: 0,
    sales_q4: 0,
    sales_q3: 0,
    sales_q2: 0,
    sales_q1: 0,
    monthly_sales_est: 0,
    alts: [],
  };
}

/** Whole calendar months between an ISO date and today (clamped to 0). */
function monthsBetween(fromISO: string | null, today: Date): number {
  if (!fromISO) return 0;
  const from = new Date(fromISO + "T00:00:00Z");
  const t = new Date(
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())
  );
  const months =
    (t.getUTCFullYear() - from.getUTCFullYear()) * 12 +
    (t.getUTCMonth() - from.getUTCMonth());
  return Math.max(0, months);
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
    const todayET = new Date().toLocaleDateString("en-CA", {
      timeZone: "America/New_York",
    });
    const tier0_meta = computeTier0Meta(todayET);
    if (months.length === 0)
      return res.json({
        months: [],
        business_days: 0,
        rows: [],
        tier0_meta,
      });

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
        row.monthly_revenue[idx] = revenue;
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

    // ── 3b. Pull Pareto fields per variant from purchasing_snapshot ─────────
    // Note: snapshot.first_sale_date = MIN across primary + alts (bundle view).
    // For data_source we also need each variant's OWN first_sale, computed below.
    const { rows: snapRows } = await db.query<{
      variant_id: string;
      weighted_revenue: string;
      pareto_rank: number | null;
      abc_class: string | null;
      xyz_class: string | null;
      cv_points: number | null;
      tier0_30d: string;
      sales_q4: string;
      sales_q3: string;
      sales_q2: string;
      sales_q1: string;
      monthly_sales_est: string;
    }>(`
      SELECT variant_id,
             weighted_revenue::text AS weighted_revenue,
             pareto_rank, abc_class, xyz_class, cv_points,
             tier0_30d::text AS tier0_30d,
             sales_q4::text AS sales_q4,
             sales_q3::text AS sales_q3,
             sales_q2::text AS sales_q2,
             sales_q1::text AS sales_q1,
             monthly_sales_est::text AS monthly_sales_est
      FROM purchasing_snapshot
    `);
    const today = new Date();
    const snapByVariant = new Map(
      snapRows.map((r) => [
        r.variant_id,
        {
          weighted_revenue: parseFloat(r.weighted_revenue) || 0,
          pareto_rank: r.pareto_rank,
          abc_class: (r.abc_class as "A" | "B" | "C" | null) ?? null,
          xyz_class: (r.xyz_class as "X" | "Y" | "Z" | "N" | null) ?? null,
          cv_points: r.cv_points,
          tier0_30d: parseFloat(r.tier0_30d) || 0,
          sales_q4: parseFloat(r.sales_q4) || 0,
          sales_q3: parseFloat(r.sales_q3) || 0,
          sales_q2: parseFloat(r.sales_q2) || 0,
          sales_q1: parseFloat(r.sales_q1) || 0,
          monthly_sales_est: parseFloat(r.monthly_sales_est) || 0,
        },
      ])
    );

    // Each variant's OWN first sale (regardless of alts). Combines pos_invoice
    // (day precision) with purchasing_sales_history (month precision).
    const { rows: ownFirstSaleRows } = await db.query<{
      variant_id: string;
      first_sale: string;
    }>(`
      SELECT variant_id, MIN(first_seen)::date::text AS first_sale
      FROM (
        SELECT pii.variant_id,
               (pi.issued_at AT TIME ZONE 'America/New_York')::date AS first_seen
        FROM pos_invoice_item pii
        JOIN pos_invoice pi ON pi.id = pii.invoice_id
        WHERE pi.status NOT IN ('voided')
          AND pii.deleted_at IS NULL
          AND pii.variant_id IS NOT NULL
          AND (pii.quantity - pii.refunded_quantity) > 0
        UNION ALL
        SELECT variant_id, month_date
        FROM purchasing_sales_history
        WHERE variant_id IS NOT NULL AND qty_sold > 0
      ) x
      GROUP BY variant_id
    `);
    const ownFirstSale = new Map(
      ownFirstSaleRows.map((r) => [r.variant_id, r.first_sale.slice(0, 10)])
    );

    // NOTE: snap+ownFirstSale application moved AFTER "ensure primary rows exist"
    // (below) so primaries with no own history but linked alts (e.g. brand-new
    // SKUs whose demand comes via alternative_proxy) still receive their
    // snapshot's weighted_revenue/pareto_rank instead of dropping to $0.

    // ── 4. Load product_alternative links ─────────────────────────────────────
    const { rows: altLinks } = await db.query<{
      primary_variant_id: string;
      alt_variant_id: string;
      primary_sku: string;
      primary_title: string;
      primary_sales_description: string;
    }>(`
      SELECT
        pa.primary_variant_id,
        pa.alt_variant_id,
        COALESCE(pv_p.sku, pa.primary_variant_id) AS primary_sku,
        COALESCE(p_p.title, pv_p.sku, pa.primary_variant_id) AS primary_title,
        COALESCE(pv_p.metadata->>'sales_description', '') AS primary_sales_description
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
      {
        sku: string;
        title: string;
        sales_description: string;
        altIds: string[];
      }
    >();

    for (const link of altLinks) {
      altSet.add(link.alt_variant_id);
      if (!primaryMap.has(link.primary_variant_id)) {
        primaryMap.set(link.primary_variant_id, {
          sku: link.primary_sku,
          title: link.primary_title,
          sales_description: link.primary_sales_description,
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
        row.sales_description = meta.sales_description;
        variantMap.set(primaryId, row);
      } else {
        // Primary already in variantMap (had own sales) but maybe its
        // sales_description was empty (e.g. no own history loaded). Backfill.
        const existing = variantMap.get(primaryId)!;
        if (!existing.sales_description) {
          existing.sales_description = meta.sales_description;
        }
      }
    }

    // Apply snapshot fields + own_first_sale to ALL rows (must be after the
    // primary-row injection above so newly-added primaries — those with no
    // own sales but with active alts — also get their weighted_revenue).
    for (const row of variantMap.values()) {
      const snap = snapByVariant.get(row.variant_id);
      if (snap) {
        row.weighted_revenue = snap.weighted_revenue;
        row.pareto_rank = snap.pareto_rank;
        row.abc_class = snap.abc_class;
        row.xyz_class = snap.xyz_class;
        row.cv_points = snap.cv_points;
        row.tier0_30d = snap.tier0_30d;
        row.sales_q4 = snap.sales_q4;
        row.sales_q3 = snap.sales_q3;
        row.sales_q2 = snap.sales_q2;
        row.sales_q1 = snap.sales_q1;
        row.monthly_sales_est = snap.monthly_sales_est;
      }
      const own = ownFirstSale.get(row.variant_id) ?? null;
      row.first_sale_date = own;
      row.history_months = monthsBetween(own, today);
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

    // Combined weighted revenue = primary's snapshot weighted_revenue.
    // Important: the engine ALREADY aggregates primary + alts (combined map)
    // when computing the primary's weighted_revenue. So row.weighted_revenue
    // IS the bundle weighted — adding alts' own weighted on top would double-count.
    // Alts' own weighted_revenue is kept for display/debugging only.
    for (const row of variantMap.values()) {
      row.combined_weighted_revenue = row.weighted_revenue;
    }

    // Demand source — explains where Pareto numbers actually come from.
    // Threshold: 12 months of history = "full" coverage.
    const FULL_HISTORY_MONTHS = 12;
    for (const row of variantMap.values()) {
      const primaryHistoric = row.history_months >= FULL_HISTORY_MONTHS;
      const altHasFull = row.alts.some(
        (a) => a.history_months >= FULL_HISTORY_MONTHS
      );
      const anySales =
        row.weighted_revenue > 0 ||
        row.alts.some((a) => a.weighted_revenue > 0);

      if (!anySales && !row.first_sale_date) {
        row.data_source = "none";
      } else if (primaryHistoric) {
        row.data_source = "self";
      } else if (altHasFull) {
        row.data_source = "alternative_proxy";
      } else {
        row.data_source = "partial";
      }
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

    return res.json({
      months,
      business_days: businessDays,
      rows,
      tier0_meta,
    });
  });
}

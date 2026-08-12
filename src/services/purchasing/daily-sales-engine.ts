/**
 * DailySalesEngine — pure, synchronous, no DB access.
 *
 * All data (tier0 totals, monthly history, biz-day counts) is pre-loaded in
 * bulk by snapshot.service and passed in. This keeps the engine fast and
 * testable without mocking Postgres.
 *
 * Formula (5 tiers):
 *   tier0_daily = units in window / Mon-Sat days in window
 *   Q4–Q1 daily = quarter units / Mon-Sat days in those months
 *   daily_est   = weighted average × (1 + tendency_adj)
 *
 * Tier0 source:
 *   • LIVE mode (default, Mon-Sat days since 2026-04-14 ≥ 26):
 *     tier0 = last 26 Mon-Sat days from pos_invoice (returns netted at sale date).
 *   • FALLBACK mode (< 26 biz days since go-live):
 *     tier0 = previous full calendar month from purchasing_sales_history.
 *     Q4..Q1 history shifts back one month to avoid double-counting that month.
 *   • APRIL 2026 BRIDGE:
 *     tier0 = QB Excel Apr 1-13 + Medusa POS Apr 14-30 while still in fallback.
 *
 * tier0_30d stored in snapshot = normalized monthly rate (daily × biz_per_month).
 */

import { Client } from "pg";

import type { PurchasingConfig } from "./purchasing-config.service";
import { computeTier0Meta } from "./tier0-window";

export interface DailySalesResult {
  tier0_30d: number; // normalized monthly rate (daily × biz_per_month)
  sales_q1: number; // raw unit total, oldest months
  sales_q2: number;
  sales_q3: number;
  sales_q4: number; // raw unit total, most recent 3 months
  sales_last_24d: number; // raw units sold in last 28 calendar days (≈24 Mon-Sat), informational
  daily_sales_est: number;
  monthly_sales_est: number;
  cv: number;
  /**
   * Months actually in the CV series (excludes the current month and, in
   * fallback mode, the tier0 month). Below MIN_CV_POINTS the XYZ class is N.
   */
  cv_points: number;
  unmet_net_30d: number; // requested − purchased (net unsatisfied demand in tier0 window)
  /**
   * Tier-weighted monthly revenue (NET of returns). Used as the Pareto
   * ranking metric. Computed as Σ (weight_tier × monthly_revenue_tier),
   * where monthly_revenue_tier = revenue_tier × (biz_per_month / biz_days_tier).
   * Weights match the demand weights (30/25/20/15/10).
   */
  weighted_revenue: number;
  /**
   * Earliest sale date across primary + alts (YYYY-MM-DD), or null if never sold.
   * Quarters fully before this date are treated as "pre-life" and dropped from
   * the weighted average; the birth quarter is partial-prorated.
   */
  first_sale_date: string | null;
}

/** Bulk context — loaded ONCE per snapshot run, shared across all variants. */
export interface SalesEngineContext {
  /** Mon-Sat days in tier0 window. */
  tier0BizDays: number;
  /** ISO start date of tier0 window (YYYY-MM-DD). */
  tier0WindowStart: string;
  /** ISO end date of tier0 window, exclusive (YYYY-MM-DD). */
  tier0WindowEnd: string;
  /** Where tier0 numbers come from this run. */
  tier0Source: "live_window" | "fallback_prev_month" | "april2026_combined";
  /** Human-readable label for the UI (e.g. "Últimos 30 días" or fallback warning). */
  tier0Label: string;
  /** True when tier0 = previous calendar month → Q4..Q1 must shift back to avoid overlap. */
  tier0InFallbackMode: boolean;
  /** month start (YYYY-MM-DD) → Mon-Sat days in that calendar month. */
  bizDaysByMonth: Map<string, number>;
  /** variant_id → raw units sold in the tier0 window (latest order version). */
  tier0ByVariant: Map<string, number>;
  /** variant_id → NET revenue (after returns) in the tier0 window. */
  tier0RevenueByVariant: Map<string, number>;
  /** variant_id → raw units sold in the last 28 calendar days (≈4 Mon-Sat weeks). */
  l4wByVariant: Map<string, number>;
  /** variant_id → sorted monthly history rows (qty + NET revenue). */
  histByVariant: Map<string, { date: string; qty: number; revenue: number }[]>;
  /** variant_id → units customers requested but couldn't get in tier0 window. */
  unmetRequestedByVariant: Map<string, number>;
  /** variant_id → units sold as forced alternatives in tier0 window. */
  unmetPurchasedByVariant: Map<string, number>;
  /** variant_id → earliest sale date (YYYY-MM-DD); used to skip pre-life quarters. */
  firstSaleByVariant: Map<string, string>;
}

/** Call once per run — loads all bulk data needed by every variant. */
export async function buildSalesEngineContext(
  db: Client
): Promise<SalesEngineContext> {
  // ── Tier0 window dates ────────────────────────────────────────────────────
  const nowET = new Date().toLocaleDateString("en-CA", {
    timeZone: "America/New_York",
  });
  const tier0Meta = computeTier0Meta(nowET);
  const tier0WindowStart = tier0Meta.window_start;
  const tier0WindowEnd = tier0Meta.window_end;
  const tier0Source = tier0Meta.source;
  const tier0Label = tier0Meta.label;
  const tier0InFallbackMode = tier0Meta.in_fallback_mode;

  // ── 1. Business days: tier0 window + per calendar month ──────────────────
  const bizRes = await db.query<{
    type: string;
    month_date: string | null;
    biz_days: string;
  }>(
    `SELECT 'tier0' AS type, NULL AS month_date,
            COUNT(CASE WHEN EXTRACT(DOW FROM d) != 0 THEN 1 END)::text AS biz_days
     FROM generate_series($1::date, ($2::date - INTERVAL '1 day')::date, '1 day'::interval) AS d(d)
     UNION ALL
     SELECT 'month', to_char(DATE_TRUNC('month', d), 'YYYY-MM-DD'),
            COUNT(CASE WHEN EXTRACT(DOW FROM d) != 0 THEN 1 END)::text
     FROM generate_series(
       DATE_TRUNC('month', NOW() - INTERVAL '13 months')::date,
       (DATE_TRUNC('month', NOW()) - INTERVAL '1 day')::date,
       '1 day'::interval
     ) AS d(d)
     GROUP BY DATE_TRUNC('month', d)`,
    [tier0WindowStart, tier0WindowEnd]
  );

  let tier0BizDays = 1;
  const bizDaysByMonth = new Map<string, number>();
  for (const row of bizRes.rows) {
    const n = Math.max(1, parseInt(row.biz_days, 10));
    if (row.type === "tier0") tier0BizDays = n;
    else if (row.month_date) bizDaysByMonth.set(row.month_date, n);
  }

  // ── 2. Tier0 totals for ALL variants ─────────────────────────────────────
  // Three modes:
  //   • april2026_combined: SUM(excel for Apr 1-13 from history) + POS from Apr 14-window_end.
  //   • fallback_prev_month: previous full calendar month from history (DISTINCT ON).
  //   • live_window: pos_invoice last 26 Mon-Sat days (returns netted at sale date).
  // Revenue is NET of returns: in pos_invoice we scale total by (qty - refunded)/qty.
  let t0Rows: { variant_id: string; total: string; revenue: string }[];
  if (tier0Source === "april2026_combined") {
    const t0Res = await db.query<{
      variant_id: string;
      total: string;
      revenue: string;
    }>(
      `SELECT variant_id,
              SUM(qty)::text AS total,
              SUM(revenue)::text AS revenue
       FROM (
         SELECT variant_id, qty_sold::numeric AS qty, revenue::numeric AS revenue
         FROM purchasing_sales_history
         WHERE month_date = '2026-04-01'::date
           AND source = 'excel_import'
           AND variant_id IS NOT NULL
         UNION ALL
         SELECT pii.variant_id,
                COALESCE(SUM(pii.quantity - pii.refunded_quantity), 0)::numeric AS qty,
                -- pos_invoice_item.total is stored in cents → divide by 100.
                COALESCE(SUM(
                  CASE
                    WHEN pii.quantity > 0 THEN
                      (pii.total::numeric / 100) * (pii.quantity - pii.refunded_quantity)::numeric / pii.quantity::numeric
                    ELSE 0
                  END
                ), 0)::numeric AS revenue
         FROM pos_invoice_item pii
         JOIN pos_invoice pi ON pi.id = pii.invoice_id
         WHERE pi.issued_at >= '2026-04-14'::date AT TIME ZONE 'America/New_York'
           AND pi.issued_at <  $1::date AT TIME ZONE 'America/New_York'
           AND pi.status NOT IN ('voided')
           AND pii.deleted_at IS NULL
           AND pii.variant_id IS NOT NULL
         GROUP BY pii.variant_id
       ) combined
       GROUP BY variant_id`,
      [tier0WindowEnd]
    );
    t0Rows = t0Res.rows;
  } else if (tier0InFallbackMode) {
    const t0Res = await db.query<{
      variant_id: string;
      total: string;
      revenue: string;
    }>(
      `SELECT DISTINCT ON (variant_id)
         variant_id,
         qty_sold::text AS total,
         revenue::text AS revenue
       FROM purchasing_sales_history
       WHERE month_date = $1::date
         AND variant_id IS NOT NULL
       ORDER BY variant_id,
                CASE source WHEN 'medusa_orders' THEN 0 ELSE 1 END`,
      [tier0WindowStart]
    );
    t0Rows = t0Res.rows;
  } else {
    const t0Res = await db.query<{
      variant_id: string;
      total: string;
      revenue: string;
    }>(
      `SELECT pii.variant_id,
              COALESCE(SUM(pii.quantity - pii.refunded_quantity), 0)::text AS total,
              -- pos_invoice_item.total is stored in cents → divide by 100.
              COALESCE(
                SUM(
                  CASE
                    WHEN pii.quantity > 0 THEN
                      (pii.total::numeric / 100) * (pii.quantity - pii.refunded_quantity)::numeric / pii.quantity::numeric
                    ELSE 0
                  END
                ),
                0
              )::text AS revenue
       FROM pos_invoice_item pii
       JOIN pos_invoice pi ON pi.id = pii.invoice_id
       WHERE pi.issued_at >= $1::date AT TIME ZONE 'America/New_York'
         AND pi.issued_at <  $2::date AT TIME ZONE 'America/New_York'
         AND pi.status NOT IN ('voided')
         AND pii.deleted_at IS NULL
         AND pii.variant_id IS NOT NULL
       GROUP BY pii.variant_id`,
      [tier0WindowStart, tier0WindowEnd]
    );
    t0Rows = t0Res.rows;
  }
  const tier0ByVariant = new Map(
    t0Rows.map((r) => [r.variant_id, parseFloat(r.total)])
  );
  const tier0RevenueByVariant = new Map(
    t0Rows.map((r) => [r.variant_id, parseFloat(r.revenue)])
  );

  // ── 2b. Last-4-weeks totals (28 calendar days, Mon-Sat) ──────────────────
  const l4wStart = new Date(Date.now() - 28 * 86400_000)
    .toISOString()
    .slice(0, 10);
  const l4wRes = await db.query<{ variant_id: string; total: string }>(
    `SELECT pii.variant_id,
            COALESCE(SUM(pii.quantity - pii.refunded_quantity), 0)::text AS total
     FROM pos_invoice_item pii
     JOIN pos_invoice pi ON pi.id = pii.invoice_id
     WHERE pi.issued_at >= $1::date AT TIME ZONE 'America/New_York'
       AND pi.issued_at <  $2::date AT TIME ZONE 'America/New_York'
       AND pi.status NOT IN ('voided')
       AND pii.deleted_at IS NULL
       AND pii.variant_id IS NOT NULL
     GROUP BY pii.variant_id`,
    [l4wStart, nowET]
  );
  const l4wByVariant = new Map(
    l4wRes.rows.map((r) => [r.variant_id, parseFloat(r.total)])
  );

  // ── 2c. Unmet demand (requested & purchased forced alternatives) ──────────
  const unmetRes = await db.query<{
    variant_id: string;
    kind: string;
    total: string;
  }>(
    `SELECT udi.variant_id, udi.kind, SUM(udi.quantity)::text AS total
     FROM unmet_demand_item udi
     JOIN unmet_demand_record udr ON udr.id = udi.record_id
     WHERE udi.variant_id IS NOT NULL
       AND udr.created_at >= $1::date
     GROUP BY udi.variant_id, udi.kind`,
    [tier0WindowStart]
  );
  const unmetRequestedByVariant = new Map<string, number>();
  const unmetPurchasedByVariant = new Map<string, number>();
  for (const row of unmetRes.rows) {
    if (row.kind === "requested") {
      unmetRequestedByVariant.set(row.variant_id, parseFloat(row.total));
    } else {
      unmetPurchasedByVariant.set(row.variant_id, parseFloat(row.total));
    }
  }

  // ── 3. Monthly history for ALL variants in one query ─────────────────────
  // DISTINCT ON per (variant_id, month_date) preferring medusa_orders over excel.
  const hRes = await db.query<{
    variant_id: string;
    month_date: string;
    qty_sold: string;
    revenue: string;
  }>(
    `SELECT DISTINCT ON (variant_id, month_date)
       variant_id,
       month_date::text,
       SUM(qty_sold) OVER (PARTITION BY variant_id, month_date)::text AS qty_sold,
       SUM(revenue)  OVER (PARTITION BY variant_id, month_date)::text AS revenue
     FROM purchasing_sales_history
     WHERE month_date >= DATE_TRUNC('month', NOW() - INTERVAL '13 months')::date
     ORDER BY variant_id, month_date,
              CASE source WHEN 'medusa_orders' THEN 0 ELSE 1 END`,
    []
  );
  const histByVariant = new Map<
    string,
    { date: string; qty: number; revenue: number }[]
  >();
  for (const row of hRes.rows) {
    const list = histByVariant.get(row.variant_id) ?? [];
    list.push({
      date: row.month_date.slice(0, 10),
      qty: parseFloat(row.qty_sold),
      revenue: parseFloat(row.revenue),
    });
    histByVariant.set(row.variant_id, list);
  }
  // Sort each list ascending by date (should already be, but ensure)
  for (const list of histByVariant.values()) {
    list.sort((a, b) => a.date.localeCompare(b.date));
  }

  // ── 4. First-sale date per variant (day precision) ────────────────────────
  // Combines pos_invoice (live, day precision) with purchasing_sales_history
  // (Excel imports, month precision → use day 1 of that month).
  const firstSaleRes = await db.query<{
    variant_id: string;
    first_sale_date: string;
  }>(
    `WITH actual_first_sale AS (
       SELECT variant_id, MIN(first_seen)::date AS first_sale
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
     ),
     override AS (
       SELECT pv.id AS variant_id,
              (pv.metadata->>'available_since')::date AS override_date
       FROM product_variant pv
       WHERE pv.deleted_at IS NULL
         AND pv.metadata->>'available_since' ~ '^\\d{4}-\\d{2}-\\d{2}$'
     )
     -- Semantic: metadata.available_since WINS if present; first sale is only
     -- the fallback. This gives users full manual control: bulk-default sets
     -- "alive 13 months ago" so empty early months pull weighted DOWN.
     -- Newer products get a later override → first sale takes effect again.
     SELECT COALESCE(o.variant_id, afs.variant_id) AS variant_id,
            COALESCE(o.override_date, afs.first_sale)::text AS first_sale_date
     FROM actual_first_sale afs
     FULL OUTER JOIN override o ON o.variant_id = afs.variant_id
     WHERE COALESCE(o.override_date, afs.first_sale) IS NOT NULL`,
    []
  );
  const firstSaleByVariant = new Map<string, string>(
    firstSaleRes.rows.map((r) => [r.variant_id, r.first_sale_date.slice(0, 10)])
  );

  return {
    tier0BizDays,
    tier0WindowStart,
    tier0WindowEnd,
    tier0Source,
    tier0Label,
    tier0InFallbackMode,
    bizDaysByMonth,
    tier0ByVariant,
    tier0RevenueByVariant,
    l4wByVariant,
    histByVariant,
    unmetRequestedByVariant,
    unmetPurchasedByVariant,
    firstSaleByVariant,
  };
}

/** Pure, synchronous — no DB calls. Runs entirely in RAM. */
export function calculateDailySales(
  primaryVariantId: string,
  altVariantIds: string[],
  cfg: PurchasingConfig,
  ctx: SalesEngineContext
): DailySalesResult {
  const allIds = [primaryVariantId, ...altVariantIds];
  const biz = cfg.business_days_per_month;

  // ── Tier0 ────────────────────────────────────────────────────────────────
  const tier0Invoiced = allIds.reduce(
    (s, id) => s + (ctx.tier0ByVariant.get(id) ?? 0),
    0
  );
  const unmetRequested = allIds.reduce(
    (s, id) => s + (ctx.unmetRequestedByVariant.get(id) ?? 0),
    0
  );
  const unmetPurchased = allIds.reduce(
    (s, id) => s + (ctx.unmetPurchasedByVariant.get(id) ?? 0),
    0
  );
  // True demand = invoiced sales + what customers wanted but couldn't get − forced alternative sales
  const tier0Raw = Math.max(0, tier0Invoiced + unmetRequested - unmetPurchased);
  const tier0Daily = tier0Raw / ctx.tier0BizDays;
  const tier0_30d = tier0Daily * biz; // normalized monthly rate

  // Tier0 NET revenue (for weighted Pareto). Sum across primary + alts.
  const tier0RevenueRaw = allIds.reduce(
    (s, id) => s + (ctx.tier0RevenueByVariant.get(id) ?? 0),
    0
  );
  // Normalize to monthly rate just like units.
  const tier0MonthlyRevenue =
    (tier0RevenueRaw / ctx.tier0BizDays) * biz;

  // ── Last 4 weeks (raw units, informational only — not used in estimate) ──
  const sales_last_24d = allIds.reduce(
    (s, id) => s + (ctx.l4wByVariant.get(id) ?? 0),
    0
  );

  // ── Monthly history (combine primary + alts, deduplicate by month) ────────
  const combinedQty = new Map<string, number>();
  const combinedRev = new Map<string, number>();
  for (const id of allIds) {
    for (const row of ctx.histByVariant.get(id) ?? []) {
      combinedQty.set(row.date, (combinedQty.get(row.date) ?? 0) + row.qty);
      combinedRev.set(
        row.date,
        (combinedRev.get(row.date) ?? 0) + row.revenue
      );
    }
  }

  // Earliest alive across the bundle. Drives the backfill (below) and the
  // birth-quarter dead-bucket detection.
  const bundleAliveDates = allIds
    .map((id) => ctx.firstSaleByVariant.get(id))
    .filter((d): d is string => !!d)
    .sort();
  const firstSaleISO = bundleAliveDates[0] ?? null;

  // Backfill missing months as 0/0 between alive_start and current month.
  // purchasing_sales_history only stores months that had sales — so without
  // backfill, months with 0 demand are invisible to the engine and get
  // skipped, inflating the weighted average. With backfill, those zeros
  // correctly drag the average down (real "no demand" signal).
  if (firstSaleISO) {
    const todayET = new Date().toLocaleDateString("en-CA", {
      timeZone: "America/New_York",
    });
    const [yT, mT] = todayET.split("-").map(Number);
    if (yT && mT) {
      const curMonth = new Date(Date.UTC(yT, mT - 1, 1));
      const aliveDate = new Date(firstSaleISO + "T00:00:00Z");
      const aliveMonthStart = new Date(
        Date.UTC(aliveDate.getUTCFullYear(), aliveDate.getUTCMonth(), 1)
      );
      // Engine only loads 12 months of history; clamp the backfill to that.
      const lookbackStart = new Date(curMonth);
      lookbackStart.setUTCMonth(lookbackStart.getUTCMonth() - 12);
      const startTs = Math.max(
        aliveMonthStart.getTime(),
        lookbackStart.getTime()
      );
      const walk = new Date(startTs);
      while (walk < curMonth) {
        const key = walk.toISOString().slice(0, 10);
        if (!combinedQty.has(key)) {
          combinedQty.set(key, 0);
          combinedRev.set(key, 0);
        }
        walk.setUTCMonth(walk.getUTCMonth() + 1);
      }
    }
  }

  let months = [...combinedQty.entries()]
    .map(([date, qty]) => ({
      date,
      qty,
      revenue: combinedRev.get(date) ?? 0,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  // In fallback / april2026 modes, tier0 covers a calendar month that's also
  // present in history — drop it from the slice so Q4 doesn't double-count.
  if (ctx.tier0Source === "april2026_combined" && months.length > 0) {
    months = months.filter((mo) => mo.date !== "2026-04-01");
  } else if (ctx.tier0InFallbackMode && months.length > 0) {
    const tier0Month = ctx.tier0WindowStart;
    months = months.filter((mo) => mo.date !== tier0Month);
  }

  type MonthRow = { date: string; qty: number; revenue: number };
  const sumQty = (arr: MonthRow[]) => arr.reduce((s, m) => s + m.qty, 0);
  const sumRev = (arr: MonthRow[]) => arr.reduce((s, m) => s + m.revenue, 0);

  // firstSaleISO already computed above (used by backfill). Returned at
  // the bottom of this function as the snapshot's first_sale_date.

  /**
   * Mon-Sat days a slice contributes. With backfill, every month in [alive_since
   * → now] is present in `months` (with qty=0 if no sales). So the slice length
   * directly reflects what's "alive" — no leading-zero magic needed. Empty
   * slices = entirely pre-life → 0 days → bucket dies and weight redistributes.
   */
  const effectiveBizDays = (slice: MonthRow[]): number => {
    if (slice.length === 0) return 0;
    return slice.reduce(
      (s, m) => s + (ctx.bizDaysByMonth.get(m.date) ?? biz),
      0
    );
  };

  const q4m = months.slice(-3);
  const q3m = months.slice(-6, -3);
  const q2m = months.slice(-9, -6);
  const q1m = months.slice(0, Math.max(0, months.length - 9));

  const sales_q4 = sumQty(q4m);
  const sales_q3 = sumQty(q3m);
  const sales_q2 = sumQty(q2m);
  const sales_q1 = sumQty(q1m);

  const q4Days = effectiveBizDays(q4m);
  const q3Days = effectiveBizDays(q3m);
  const q2Days = effectiveBizDays(q2m);
  const q1Days = effectiveBizDays(q1m);

  const q4_daily = q4Days > 0 ? sales_q4 / q4Days : 0;
  const q3_daily = q3Days > 0 ? sales_q3 / q3Days : 0;
  const q2_daily = q2Days > 0 ? sales_q2 / q2Days : 0;
  const q1_daily = q1Days > 0 ? sales_q1 / q1Days : 0;

  // Per-tier monthly revenue: revenue_tier × (biz_per_month / biz_days_tier).
  // Uses effective days so birth quarter isn't diluted by pre-life days.
  const monthlyRevFor = (slice: MonthRow[], days: number) =>
    days > 0 ? (sumRev(slice) / days) * biz : 0;
  const q4_monthly_revenue = monthlyRevFor(q4m, q4Days);
  const q3_monthly_revenue = monthlyRevFor(q3m, q3Days);
  const q2_monthly_revenue = monthlyRevFor(q2m, q2Days);
  const q1_monthly_revenue = monthlyRevFor(q1m, q1Days);

  // A quarter is "alive" iff its slice has any months. Thanks to backfill
  // (above), the slice is non-empty iff the bundle was alive (per metadata
  // override or first sale) during any month covered by the slice. Quarters
  // entirely before alive_since stay empty → bucket dies → weight redistributes.
  // Once alive, a quarter with daily=0 is a real "no demand" signal that
  // correctly drags the weighted average down.
  const buckets = [
    { daily: tier0Daily, weight: cfg.weight_tier0_30d, alive: true,
      monthlyRev: tier0MonthlyRevenue },
    { daily: q1_daily, weight: cfg.weight_q1, alive: q1m.length > 0,
      monthlyRev: q1_monthly_revenue },
    { daily: q2_daily, weight: cfg.weight_q2, alive: q2m.length > 0,
      monthlyRev: q2_monthly_revenue },
    { daily: q3_daily, weight: cfg.weight_q3, alive: q3m.length > 0,
      monthlyRev: q3_monthly_revenue },
    { daily: q4_daily, weight: cfg.weight_q4, alive: q4m.length > 0,
      monthlyRev: q4_monthly_revenue },
  ];
  const totalWeight = buckets.reduce((s, b) => s + b.weight, 0);
  const liveWeight = buckets
    .filter((b) => b.alive)
    .reduce((s, b) => s + b.weight, 0);
  const renorm = liveWeight > 0 ? totalWeight / liveWeight : 0;

  const weighted = buckets
    .filter((b) => b.alive)
    .reduce((s, b) => s + b.weight * b.daily, 0) * renorm;

  const daily_sales_est = weighted * (1 + cfg.tendency_adj);
  const monthly_sales_est = daily_sales_est * biz;

  // Weighted monthly NET revenue — Pareto ranking metric.
  // Same redistribution: dead buckets don't drag revenue down.
  const weighted_revenue = buckets
    .filter((b) => b.alive)
    .reduce((s, b) => s + b.weight * b.monthlyRev, 0) * renorm;

  // ── CV (for XYZ classification) ───────────────────────────────────────────
  const qtys = months.map((m) => m.qty);
  const mean =
    qtys.length > 0 ? qtys.reduce((s, v) => s + v, 0) / qtys.length : 0;
  const variance =
    qtys.length > 1
      ? qtys.reduce((s, v) => s + (v - mean) ** 2, 0) / qtys.length
      : 0;
  const cv = mean > 0 ? Math.sqrt(variance) / mean : 0;

  return {
    tier0_30d,
    sales_q1,
    sales_q2,
    sales_q3,
    sales_q4,
    sales_last_24d: Math.round(sales_last_24d * 100) / 100,
    daily_sales_est: Math.round(daily_sales_est * 10000) / 10000,
    monthly_sales_est: Math.round(monthly_sales_est * 100) / 100,
    cv: Math.round(cv * 10000) / 10000,
    cv_points: qtys.length,
    unmet_net_30d: Math.round((unmetRequested - unmetPurchased) * 100) / 100,
    weighted_revenue: Math.round(weighted_revenue * 100) / 100,
    first_sale_date: firstSaleISO,
  };
}

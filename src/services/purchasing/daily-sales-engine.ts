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
 * April 2026 exception: window starts 2026-04-14 (Medusa go-live).
 * From May 2026 onward: standard last-30-days window.
 *
 * tier0_30d stored in snapshot = normalized monthly rate (daily × biz_per_month).
 */

import { Client } from "pg";

import type { PurchasingConfig } from "./purchasing-config.service";

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
}

/** Bulk context — loaded ONCE per snapshot run, shared across all variants. */
export interface SalesEngineContext {
  /** Mon-Sat days in tier0 window. */
  tier0BizDays: number;
  /** ISO start date of tier0 window (YYYY-MM-DD). */
  tier0WindowStart: string;
  /** month start (YYYY-MM-DD) → Mon-Sat days in that calendar month. */
  bizDaysByMonth: Map<string, number>;
  /** variant_id → raw units sold in the tier0 window (latest order version). */
  tier0ByVariant: Map<string, number>;
  /** variant_id → raw units sold in the last 28 calendar days (≈4 Mon-Sat weeks). */
  l4wByVariant: Map<string, number>;
  /** variant_id → sorted monthly history rows. */
  histByVariant: Map<string, { date: string; qty: number }[]>;
}

/** Call once per run — loads all bulk data needed by every variant. */
export async function buildSalesEngineContext(
  db: Client
): Promise<SalesEngineContext> {
  // ── Tier0 window dates ────────────────────────────────────────────────────
  const nowET = new Date().toLocaleDateString("en-CA", {
    timeZone: "America/New_York",
  });
  const [y, m] = nowET.split("-").map(Number);
  const isApril2026 = y === 2026 && m === 4;
  const GOLIVE = "2026-04-14";
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86400_000)
    .toISOString()
    .slice(0, 10);
  const tier0WindowStart = isApril2026 ? GOLIVE : thirtyDaysAgo;
  const yesterday = new Date(Date.now() - 86400_000).toISOString().slice(0, 10);

  // ── 1. Business days: tier0 window + per calendar month ──────────────────
  const bizRes = await db.query<{
    type: string;
    month_date: string | null;
    biz_days: string;
  }>(
    `SELECT 'tier0' AS type, NULL AS month_date,
            COUNT(CASE WHEN EXTRACT(DOW FROM d) != 0 THEN 1 END)::text AS biz_days
     FROM generate_series($1::date, $2::date, '1 day'::interval) AS d(d)
     UNION ALL
     SELECT 'month', to_char(DATE_TRUNC('month', d), 'YYYY-MM-DD'),
            COUNT(CASE WHEN EXTRACT(DOW FROM d) != 0 THEN 1 END)::text
     FROM generate_series(
       (NOW() - INTERVAL '12 months')::date,
       (DATE_TRUNC('month', NOW()) - INTERVAL '1 day')::date,
       '1 day'::interval
     ) AS d(d)
     GROUP BY DATE_TRUNC('month', d)`,
    [tier0WindowStart, yesterday]
  );

  let tier0BizDays = 1;
  const bizDaysByMonth = new Map<string, number>();
  for (const row of bizRes.rows) {
    const n = Math.max(1, parseInt(row.biz_days, 10));
    if (row.type === "tier0") tier0BizDays = n;
    else if (row.month_date) bizDaysByMonth.set(row.month_date, n);
  }

  // ── 2. Tier0 totals for ALL variants in one query (POS invoices only) ───────
  const t0Res = await db.query<{ variant_id: string; total: string }>(
    `SELECT pii.variant_id,
            COALESCE(SUM(pii.quantity - pii.refunded_quantity), 0)::text AS total
     FROM pos_invoice_item pii
     JOIN pos_invoice pi ON pi.id = pii.invoice_id
     WHERE pi.issued_at >= $1::date AT TIME ZONE 'America/New_York'
       AND pi.status NOT IN ('voided')
       AND pii.deleted_at IS NULL
       AND pii.variant_id IS NOT NULL
     GROUP BY pii.variant_id`,
    [tier0WindowStart]
  );
  const tier0ByVariant = new Map(
    t0Res.rows.map((r) => [r.variant_id, parseFloat(r.total)])
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
    [l4wStart, yesterday]
  );
  const l4wByVariant = new Map(
    l4wRes.rows.map((r) => [r.variant_id, parseFloat(r.total)])
  );

  // ── 3. Monthly history for ALL variants in one query ─────────────────────
  // DISTINCT ON per (variant_id, month_date) preferring medusa_orders over excel.
  const hRes = await db.query<{
    variant_id: string;
    month_date: string;
    qty_sold: string;
  }>(
    `SELECT DISTINCT ON (variant_id, month_date)
       variant_id,
       month_date::text,
       SUM(qty_sold) OVER (PARTITION BY variant_id, month_date)::text AS qty_sold
     FROM purchasing_sales_history
     WHERE month_date >= (NOW() - INTERVAL '12 months')::date
     ORDER BY variant_id, month_date,
              CASE source WHEN 'medusa_orders' THEN 0 ELSE 1 END`,
    []
  );
  const histByVariant = new Map<string, { date: string; qty: number }[]>();
  for (const row of hRes.rows) {
    const list = histByVariant.get(row.variant_id) ?? [];
    list.push({
      date: row.month_date.slice(0, 10),
      qty: parseFloat(row.qty_sold),
    });
    histByVariant.set(row.variant_id, list);
  }
  // Sort each list ascending by date (should already be, but ensure)
  for (const list of histByVariant.values()) {
    list.sort((a, b) => a.date.localeCompare(b.date));
  }

  return {
    tier0BizDays,
    tier0WindowStart,
    bizDaysByMonth,
    tier0ByVariant,
    l4wByVariant,
    histByVariant,
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
  const tier0Raw = allIds.reduce(
    (s, id) => s + (ctx.tier0ByVariant.get(id) ?? 0),
    0
  );
  const tier0Daily = tier0Raw / ctx.tier0BizDays;
  const tier0_30d = tier0Daily * biz; // normalized monthly rate

  // ── Last 4 weeks (raw units, informational only — not used in estimate) ──
  const sales_last_24d = allIds.reduce(
    (s, id) => s + (ctx.l4wByVariant.get(id) ?? 0),
    0
  );

  // ── Monthly history (combine primary + alts, deduplicate by month) ────────
  const combined = new Map<string, number>();
  for (const id of allIds) {
    for (const row of ctx.histByVariant.get(id) ?? []) {
      combined.set(row.date, (combined.get(row.date) ?? 0) + row.qty);
    }
  }
  const months = [...combined.entries()]
    .map(([date, qty]) => ({ date, qty }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const sum = (arr: { date: string; qty: number }[]) =>
    arr.reduce((s, m) => s + m.qty, 0);
  const bizFor = (slice: { date: string; qty: number }[]) =>
    Math.max(
      1,
      slice.reduce((s, m) => s + (ctx.bizDaysByMonth.get(m.date) ?? biz), 0)
    );

  const q4m = months.slice(-3);
  const q3m = months.slice(-6, -3);
  const q2m = months.slice(-9, -6);
  const q1m = months.slice(0, Math.max(0, months.length - 9));

  const sales_q4 = sum(q4m);
  const sales_q3 = sum(q3m);
  const sales_q2 = sum(q2m);
  const sales_q1 = sum(q1m);

  const q4_daily = sales_q4 / bizFor(q4m);
  const q3_daily = sales_q3 / bizFor(q3m);
  const q2_daily = sales_q2 / bizFor(q2m);
  const q1_daily = sales_q1 / bizFor(q1m);

  const weighted =
    cfg.weight_tier0_30d * tier0Daily +
    cfg.weight_q4 * q4_daily +
    cfg.weight_q3 * q3_daily +
    cfg.weight_q2 * q2_daily +
    cfg.weight_q1 * q1_daily;

  const daily_sales_est = weighted * (1 + cfg.tendency_adj);
  const monthly_sales_est = daily_sales_est * biz;

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
  };
}

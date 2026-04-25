/**
 * DailySalesEngine
 *
 * Calculates weighted daily sales for a variant (+ its alternatives).
 *
 * Formula (5 tiers):
 *   tier0_daily = Medusa orders last 30 days / 30
 *   Q4_daily    = sales months 10-12 / (3 × biz_days)   ← most recent quarter
 *   Q3_daily    = sales months  7-9  / (3 × biz_days)
 *   Q2_daily    = sales months  4-6  / (3 × biz_days)
 *   Q1_daily    = sales months  1-3  / (3 × biz_days)   ← oldest
 *
 *   daily_est = (w0*tier0 + w4*Q4 + w3*Q3 + w2*Q2 + w1*Q1) × (1 + tendency_adj)
 *
 * Alternatives: their sales are SUMMED with the primary before weighting.
 * The engine does NOT deduct alternative inventory — that is done at snapshot level.
 */

import { Client } from "pg";
import { PurchasingConfig } from "./purchasing-config.service";

export interface DailySalesResult {
  tier0_30d: number;
  sales_q1: number;
  sales_q2: number;
  sales_q3: number;
  sales_q4: number;
  daily_sales_est: number;
  monthly_sales_est: number;
  cv: number;
}

type MonthlyRow = { month_date: string; qty_sold: number };

export async function calculateDailySales(
  db: Client,
  primaryVariantId: string,
  altVariantIds: string[],
  cfg: PurchasingConfig
): Promise<DailySalesResult> {
  const allIds = [primaryVariantId, ...altVariantIds];

  // ── Tier0: Medusa orders in the last 30 days ────────────────────────────────
  const tier0Res = await db.query<{ total: string }>(
    `SELECT COALESCE(SUM(oi.quantity), 0)::numeric AS total
     FROM order_item oi
     JOIN order_line_item oli ON oli.id = oi.item_id
     JOIN "order" o ON o.id = oi.order_id
     WHERE oli.variant_id = ANY($1::text[])
       AND o.created_at >= NOW() - INTERVAL '30 days'
       AND o.status NOT IN ('canceled', 'archived')`,
    [allIds]
  );
  const tier0_30d = parseFloat(tier0Res.rows[0]?.total ?? "0");

  // ── Last 12 months from purchasing_sales_history ────────────────────────────
  // Prefer medusa_orders; fall back to excel_import for months not yet synced.
  const histRes = await db.query<MonthlyRow>(
    `SELECT DISTINCT ON (month_date)
       month_date::text,
       SUM(qty_sold) OVER (PARTITION BY month_date) AS qty_sold
     FROM purchasing_sales_history
     WHERE variant_id = ANY($1::text[])
       AND month_date >= (NOW() - INTERVAL '12 months')::date
     ORDER BY month_date,
              CASE source WHEN 'medusa_orders' THEN 0 ELSE 1 END`,
    [allIds]
  );

  // Sort months ascending (oldest → newest)
  const months = histRes.rows
    .map((r) => ({ date: r.month_date, qty: Number(r.qty_sold) }))
    .sort((a, b) => a.date.localeCompare(b.date));

  // Assign to quarters (oldest 3 = Q1, next 3 = Q2, ...)
  // Align to exactly 12 slots — use the last 12 available months
  const aligned = months.slice(-12);
  const getSlice = (start: number, end: number) =>
    aligned.slice(start, end).reduce((s, m) => s + m.qty, 0);

  const sales_q1 = getSlice(0, 3);
  const sales_q2 = getSlice(3, 6);
  const sales_q3 = getSlice(6, 9);
  const sales_q4 = getSlice(9, 12);

  const biz = cfg.business_days_per_month;
  const tier0_daily = tier0_30d / 30;
  const q4_daily    = sales_q4 / (3 * biz);
  const q3_daily    = sales_q3 / (3 * biz);
  const q2_daily    = sales_q2 / (3 * biz);
  const q1_daily    = sales_q1 / (3 * biz);

  const weighted =
    cfg.weight_tier0_30d * tier0_daily +
    cfg.weight_q4 * q4_daily +
    cfg.weight_q3 * q3_daily +
    cfg.weight_q2 * q2_daily +
    cfg.weight_q1 * q1_daily;

  const daily_sales_est = weighted * (1 + cfg.tendency_adj);
  const monthly_sales_est = daily_sales_est * biz;

  // ── Coefficient of Variation (for XYZ) ─────────────────────────────────────
  const qtys = aligned.map((m) => m.qty);
  const mean = qtys.length > 0 ? qtys.reduce((s, v) => s + v, 0) / qtys.length : 0;
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
    daily_sales_est: Math.round(daily_sales_est * 10000) / 10000,
    monthly_sales_est: Math.round(monthly_sales_est * 100) / 100,
    cv: Math.round(cv * 10000) / 10000,
  };
}

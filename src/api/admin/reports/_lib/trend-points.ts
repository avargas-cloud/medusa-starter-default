/**
 * Merge of the two halves of a sales trend: invoices and returns.
 *
 * Pure and exported so `src/__tests__/reports/trend-points.unit.spec.ts` can
 * gate the arithmetic. It is money: the endpoint that used to do this inline
 * skipped returns entirely, so its chart plotted gross while the KPI tiles on
 * the same screen plotted net, and its "Gross Profit" line was overstated by
 * the full refund amount on top of that.
 *
 * Definitions, copied from the summary endpoint (the canonical ones):
 *   net_revenue  = gross_revenue − returns
 *   gross_profit = net_revenue − COGS     ← NET, not gross
 *   margin_pct   = gross_profit / net_revenue
 */

export interface SalesRow {
  /** Bucket label: "YYYY-MM" or "YYYY-MM-DD". */
  bucket: string
  /** Billed, in CENTS (pos_invoice money columns are cents). */
  revenue: number | string
  /** COGS already in DOLLARS — COST_DOLLARS converts it in SQL. */
  cogs: number | string
}

export interface RefundRow {
  bucket: string
  /** Completed credit memos, in CENTS. */
  refund_cents: number | string
}

export interface TrendPoint {
  label: string
  /** Net — what every chart plots. */
  revenue: number
  gross_revenue: number
  refunded: number
  profit: number
  margin: number
}

/**
 * Every amount here starts life as an exact number of cents, so rounding to two
 * decimals only strips binary-float noise — it never moves a real value.
 * Without it `114174.35 - 4699.95` returns `109474.40000000001`, which is
 * harmless on screen and poison to any equality check downstream.
 */
function round2(n: number): number {
  return Math.round(n * 100) / 100
}

export function mergeTrendPoints(salesRows: SalesRow[], refundRows: RefundRow[]): TrendPoint[] {
  const sales = new Map<string, { revenue: number; cogs: number }>()
  for (const r of salesRows) {
    sales.set(String(r.bucket), {
      revenue: Number(r.revenue) / 100,
      cogs: Number(r.cogs),
    })
  }

  const refunds = new Map<string, number>()
  for (const r of refundRows) {
    refunds.set(String(r.bucket), Number(r.refund_cents) / 100)
  }

  // The UNION, not the sales keys: a month whose only activity was a return has
  // no invoice row at all, and dropping it would hide a real negative month.
  // Both label shapes sort lexicographically in calendar order, so no date
  // parsing is needed to come out ordered.
  const labels = [...new Set([...sales.keys(), ...refunds.keys()])].sort()

  return labels.map((label) => {
    const sale = sales.get(label) ?? { revenue: 0, cogs: 0 }
    const refunded = round2(refunds.get(label) ?? 0)
    const gross_revenue = round2(sale.revenue)
    const revenue = round2(gross_revenue - refunded)
    const profit = round2(revenue - sale.cogs)
    // Margin is undefined on a non-positive net; 0 is the honest placeholder,
    // and it keeps the right-hand axis (fixed 0–100) from being handed a value
    // it cannot draw.
    const margin = revenue > 0 ? Math.round((profit / revenue) * 1000) / 10 : 0
    return { label, revenue, gross_revenue, refunded, profit, margin }
  })
}

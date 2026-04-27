/**
 * Consolidates one calendar month of POS invoice sales into purchasing_sales_history
 * under source='medusa_orders'. The Daily Sales Engine prefers medusa_orders over
 * excel_import via DISTINCT ON, so this is what causes Q1..Q4 to migrate from QB
 * Excel to native Medusa data over time.
 *
 * Skipped months: 2026-04 (partial — Medusa went live 2026-04-14; QB Excel for
 * April is the more reliable source and stays untouched).
 */

import { Client } from "pg";

// 2026-04 used to be skipped here, but now we WANT it: the engine combines
// excel_import (days 1-13 from QB) with medusa_orders (days 14-30) for that
// row. The May-2 cron will write the medusa half automatically.
const SKIP_MONTHS = new Set<string>([]);

export interface MonthlyConsolidationResult {
  monthDate: string; // YYYY-MM-01
  skipped: boolean;
  variantsWritten: number;
  totalQty: number;
  totalRevenue: number;
  durationMs: number;
}

/** monthDate must be the first of a calendar month, YYYY-MM-01. */
export async function consolidateMonthFromMedusa(
  monthDate: string
): Promise<MonthlyConsolidationResult> {
  const start = Date.now();
  if (!/^\d{4}-\d{2}-01$/.test(monthDate)) {
    throw new Error(
      `consolidateMonthFromMedusa: monthDate must be YYYY-MM-01, got ${monthDate}`
    );
  }
  if (SKIP_MONTHS.has(monthDate)) {
    return {
      monthDate,
      skipped: true,
      variantsWritten: 0,
      totalQty: 0,
      totalRevenue: 0,
      durationMs: Date.now() - start,
    };
  }

  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  try {
    // Compute next month for half-open range [monthDate, nextMonth)
    const [yStr, mStr] = monthDate.split("-");
    const y = Number(yStr);
    const m = Number(mStr);
    const nextY = m === 12 ? y + 1 : y;
    const nextM = m === 12 ? 1 : m + 1;
    const nextMonth = `${nextY}-${String(nextM).padStart(2, "0")}-01`;

    // Aggregate net qty + net revenue per variant for that calendar month, ET.
    // Revenue is scaled by net/gross qty ratio so refunds reduce both proportionally.
    const agg = await db.query<{
      variant_id: string;
      qty_sold: string;
      revenue: string;
    }>(
      `SELECT pii.variant_id,
              SUM(pii.quantity - pii.refunded_quantity)::int::text AS qty_sold,
              -- pos_invoice_item.total is stored in cents → divide by 100.
              COALESCE(SUM(
                CASE
                  WHEN pii.quantity > 0 THEN
                    (pii.total::numeric / 100) * (pii.quantity - pii.refunded_quantity)::numeric / pii.quantity::numeric
                  ELSE 0
                END
              ), 0)::numeric(14,2)::text AS revenue
       FROM pos_invoice_item pii
       JOIN pos_invoice pi ON pi.id = pii.invoice_id
       WHERE pi.issued_at >= $1::date AT TIME ZONE 'America/New_York'
         AND pi.issued_at <  $2::date AT TIME ZONE 'America/New_York'
         AND pi.status NOT IN ('voided')
         AND pii.deleted_at IS NULL
         AND pii.variant_id IS NOT NULL
       GROUP BY pii.variant_id
       HAVING SUM(pii.quantity - pii.refunded_quantity) > 0`,
      [monthDate, nextMonth]
    );

    if (agg.rows.length === 0) {
      return {
        monthDate,
        skipped: false,
        variantsWritten: 0,
        totalQty: 0,
        totalRevenue: 0,
        durationMs: Date.now() - start,
      };
    }

    // Batch upsert
    const values: unknown[] = [];
    const placeholders: string[] = [];
    let p = 1;
    let totalQty = 0;
    let totalRevenue = 0;
    for (const r of agg.rows) {
      const id = `psh_${Math.random().toString(36).slice(2, 10)}${Math.random().toString(36).slice(2, 10)}`;
      const qty = parseInt(r.qty_sold, 10);
      const rev = parseFloat(r.revenue);
      totalQty += qty;
      totalRevenue += rev;
      values.push(id, r.variant_id, monthDate, qty, rev);
      placeholders.push(`($${p},$${p + 1},$${p + 2}::date,$${p + 3},$${p + 4},'medusa_orders',now(),now())`);
      p += 5;
    }
    await db.query(
      `INSERT INTO purchasing_sales_history
         (id, variant_id, month_date, qty_sold, revenue, source, created_at, updated_at)
       VALUES ${placeholders.join(",")}
       ON CONFLICT (variant_id, month_date, source)
       DO UPDATE SET qty_sold = EXCLUDED.qty_sold,
                     revenue  = EXCLUDED.revenue,
                     updated_at = now()`,
      values
    );

    return {
      monthDate,
      skipped: false,
      variantsWritten: agg.rows.length,
      totalQty,
      totalRevenue: Math.round(totalRevenue * 100) / 100,
      durationMs: Date.now() - start,
    };
  } finally {
    await db.end();
  }
}

/** Returns YYYY-MM-01 for the calendar month BEFORE the given date (ET). */
export function previousCalendarMonth(refIsoDate: string): string {
  const [yStr, mStr] = refIsoDate.split("-");
  const y = Number(yStr);
  const m = Number(mStr);
  const prevY = m === 1 ? y - 1 : y;
  const prevM = m === 1 ? 12 : m - 1;
  return `${prevY}-${String(prevM).padStart(2, "0")}-01`;
}

/**
 * Manual backfill — consolidates POS invoice sales into purchasing_sales_history
 * for one month or a range of months.
 *
 * Usage:
 *   month=2026-05-01 npx medusa exec ./src/scripts/sync/backfill-monthly-sales-from-medusa.ts
 *   from=2026-05-01 to=2026-07-01 npx medusa exec ./src/scripts/sync/backfill-monthly-sales-from-medusa.ts
 *
 * If neither is provided, defaults to the previous calendar month.
 */

import {
  consolidateMonthFromMedusa,
  previousCalendarMonth,
} from "../../services/purchasing/consolidate-monthly-sales.service";

function* iterMonths(fromIso: string, toIso: string): Generator<string> {
  const [fy, fm] = fromIso.split("-").map(Number);
  const [ty, tm] = toIso.split("-").map(Number);
  let y = fy!,
    m = fm!;
  while (y < ty! || (y === ty! && m <= tm!)) {
    yield `${y}-${String(m).padStart(2, "0")}-01`;
    m++;
    if (m === 13) {
      m = 1;
      y++;
    }
  }
}

export default async function backfillMonthlySalesFromMedusa(): Promise<void> {
  const month = process.env.month;
  const from = process.env.from;
  const to = process.env.to;

  let months: string[];
  if (month) {
    months = [month];
  } else if (from && to) {
    months = [...iterMonths(from, to)];
  } else {
    const todayET = new Date().toLocaleDateString("en-CA", {
      timeZone: "America/New_York",
    });
    months = [previousCalendarMonth(todayET)];
  }

  console.log(`[backfill] Processing ${months.length} month(s): ${months.join(", ")}`);
  for (const m of months) {
    try {
      const r = await consolidateMonthFromMedusa(m);
      if (r.skipped) {
        console.log(`[backfill] ⊘ ${m} skipped (SKIP_MONTHS)`);
      } else {
        console.log(
          `[backfill] ✓ ${m}: ${r.variantsWritten} variants, qty=${r.totalQty}, rev=$${r.totalRevenue}, ${r.durationMs}ms`
        );
      }
    } catch (e) {
      console.error(`[backfill] ✗ ${m}: ${(e as Error).message}`);
    }
  }
}

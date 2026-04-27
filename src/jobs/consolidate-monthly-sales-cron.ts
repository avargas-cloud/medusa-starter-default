/**
 * Consolidate previous month of POS invoice sales into purchasing_sales_history
 * (source='medusa_orders'). Runs day 2 of each month at 03:00 ET.
 *
 * Why day 2: gives a full safety margin past month-end for any late-night
 * invoicing on the 1st (timezone edge cases) and any reconciliation tweaks.
 *
 * The Daily Sales Engine prefers source='medusa_orders' over 'excel_import' via
 * DISTINCT ON, so this is what migrates Q1..Q4 from QuickBooks to native Medusa
 * data over time. April 2027 → 12-month window has rolled past the QB-only
 * months → 100% Medusa.
 */

import type { MedusaContainer } from "@medusajs/framework/types";

import {
  consolidateMonthFromMedusa,
  previousCalendarMonth,
} from "../services/purchasing/consolidate-monthly-sales.service";

export const config = {
  name: "consolidate-monthly-sales-from-medusa",
  schedule: "0 3 2 * *", // 03:00 on day-of-month 2
};

export default async function consolidateMonthlySalesCron(
  _container: MedusaContainer
) {
  const logger = console;
  const todayET = new Date().toLocaleDateString("en-CA", {
    timeZone: "America/New_York",
  });
  const month = previousCalendarMonth(todayET);
  logger.info(`[consolidate-sales] Running for month ${month}...`);

  try {
    const result = await consolidateMonthFromMedusa(month);
    if (result.skipped) {
      logger.info(
        `[consolidate-sales] ⊘ Skipped ${month} (in SKIP_MONTHS list, e.g. partial go-live month)`
      );
    } else {
      logger.info(
        `[consolidate-sales] ✓ ${month}: ${result.variantsWritten} variants, qty=${result.totalQty}, rev=$${result.totalRevenue}, ${result.durationMs}ms`
      );
    }
  } catch (e) {
    logger.error(
      `[consolidate-sales] ✗ Failed for ${month}: ${(e as Error).message}`
    );
  }
}

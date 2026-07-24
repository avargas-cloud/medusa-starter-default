import type { MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/utils";

import { captureInventoryValuationSnapshot } from "../lib/cost/inventory-snapshot";
import { isScheduledJobsDisabled } from "./_lib/_scheduled-jobs-guard";

/**
 * Month-close inventory valuation snapshot.
 *
 * Runs early on the 1st of each month and freezes both warehouses' closing
 * value for the month that just ended (`asOf` = the last instant of the prior
 * month, reconstructed exactly). Each close is an immutable record, so a
 * closed month's value stops moving when costs later change — the accounting
 * control Phase 1's live reconstruction alone can't provide.
 *
 * Idempotent: skips a warehouse that already has a complete month_close within
 * a day of the same boundary, so a retry (or a duplicate cron tick) doesn't
 * mint a second snapshot for the same close.
 *
 * Runs against the REAL prod DB via ./back — guarded by DISABLE_SCHEDULED_JOBS
 * so local/preview boots don't capture snapshots off dev data.
 */
export default async function inventoryValuationMonthClose(
  container: MedusaContainer
) {
  if (isScheduledJobsDisabled(container)) return;

  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const knex = container.resolve("__pg_connection__") as {
    raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: any[] }>;
    transaction?: () => Promise<any>;
  };

  // Last instant of the prior month, in UTC. The report's period boundaries use
  // UTC ISO strings, so a month-close anchored here lines up with them.
  const now = new Date();
  const firstOfThisMonth = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0)
  );
  const asOf = new Date(firstOfThisMonth.getTime() - 1).toISOString(); // 23:59:59.999 prior month

  for (const warehouse of ["miami", "china"] as const) {
    const locationId =
      warehouse === "miami"
        ? "sloc_01KFS2AV3TAKR141KC2D6JCGTR"
        : "sloc_01KQ14C1CFX30EDD722BF87HDM";

    // Already captured this close? (within a 1-day window of the boundary)
    const existing = await knex.raw(
      `SELECT id FROM inventory_valuation_snapshot
        WHERE stock_location_id = ? AND snapshot_type = 'month_close' AND status = 'complete'
          AND as_of_at BETWEEN ?::timestamptz - interval '1 day' AND ?::timestamptz + interval '1 day'
        LIMIT 1`,
      [locationId, asOf, asOf]
    );
    if (existing.rows[0]) {
      logger.info(
        `[inventory-valuation-month-close] ${warehouse} already captured for ${asOf} (${existing.rows[0].id}) — skipping`
      );
      continue;
    }

    try {
      const r = await captureInventoryValuationSnapshot(knex, {
        warehouse,
        asOf,
        snapshotType: "month_close",
        note: `automatic month close ${asOf.slice(0, 7)}`,
      });
      logger.info(
        `[inventory-valuation-month-close] ${warehouse} ${asOf.slice(0, 7)} → ${r.snapshotId}: ` +
          `${r.variantCount} lines, $${(r.totalValueCents / 100).toFixed(2)}`
      );
    } catch (error) {
      // Non-fatal per warehouse — a China failure must not stop Miami's close.
      logger.error(
        `[inventory-valuation-month-close] ${warehouse} ${asOf.slice(0, 7)} failed: ` +
          `${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}

export const config = {
  name: "inventory-valuation-month-close",
  // 00:20 on the 1st of every month, after midnight settles.
  schedule: "20 0 1 * *",
};

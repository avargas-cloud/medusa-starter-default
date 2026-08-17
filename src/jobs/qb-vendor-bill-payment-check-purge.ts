import type { MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/utils";

import { getDbPool } from "../api/utils/db-pool";
import { isScheduledJobsDisabled } from "./_lib/_scheduled-jobs-guard";

const LOG_PREFIX = "[QB-VENDOR-BILL-PAYMENT-CHECK-PURGE]";

/**
 * Purges terminal (failed/skipped) vendor_bill_payment_check rows once they've
 * outlived the 12h re-election suppression window in qb-vendor-bill-payment-monitor.ts.
 *
 * These rows are timeout artifacts of OUR stale-cleanup giving up on the bridge
 * (not QuickBooks rejections — see stale-cleanup-pass.ts), and any qb_missing_in_qb_at
 * finding they represent already lives on vendor_bill, not on this row. Once a
 * bill's suppression window has passed, the row has no remaining function —
 * including for bills that got paid in the meantime and will never be
 * re-elected by the monitor to naturally supersede their old failed rows.
 */
export default async function qbVendorBillPaymentCheckPurge(
  container: MedusaContainer
): Promise<void> {
  if (isScheduledJobsDisabled(container)) return;

  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const retentionHours = Number(
    process.env.VENDOR_BILL_PAYMENT_CHECK_PURGE_RETENTION_HOURS ?? 24
  );
  if (
    !Number.isInteger(retentionHours) ||
    retentionHours < 1 ||
    retentionHours > 720
  ) {
    logger.warn(`${LOG_PREFIX} invalid retention hours: ${retentionHours}`);
    return;
  }

  const pool = getDbPool();
  const result = await pool.query(
    `DELETE FROM qb_order_pipeline
      WHERE step = 'vendor_bill_payment_check'
        AND status IN ('failed', 'skipped')
        AND created_at < NOW() - ($1::int * INTERVAL '1 hour')`,
    [retentionHours]
  );

  if (result.rowCount && result.rowCount > 0) {
    logger.info(
      `${LOG_PREFIX} purged ${result.rowCount} row(s) older than ${retentionHours}h`
    );
  }
}

export const config = {
  name: "qb-vendor-bill-payment-check-purge",
  schedule: "35 4 * * *",
};

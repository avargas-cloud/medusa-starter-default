import type { MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/utils";

import { getDbPool } from "../api/utils/db-pool";
import { isScheduledJobsDisabled } from "./_lib/_scheduled-jobs-guard";

const LOG_PREFIX = "[QB-VENDOR-BILL-PAYMENT-MONITOR]";
const BATCH_SIZE = 20;

/**
 * Enqueues read-only BillQuery checks for linked, unpaid Vendor Bills.
 *
 * QuickBooks Desktop cannot push payment webhooks. This hourly producer keeps
 * the POS current without bypassing the one-caller rule: it only writes
 * qb_order_pipeline rows; the consolidator performs every bridge call.
 */
export default async function qbVendorBillPaymentMonitor(
  container: MedusaContainer
): Promise<void> {
  if (isScheduledJobsDisabled(container)) return;
  if (process.env.QB_ORDER_FLOW_ENABLED !== "true") return;

  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const pool = getDbPool();
  const result = await pool.query(
    `WITH candidates AS (
       SELECT vb.id, vb.purchase_order_id, vb.qb_txn_id, vb.qb_ref_number
         FROM vendor_bill vb
        WHERE vb.deleted_at IS NULL
          AND vb.qb_txn_id IS NOT NULL
          AND vb.qb_is_paid = false
          AND (
            vb.qb_payment_checked_at IS NULL
            OR vb.qb_payment_checked_at < NOW() - INTERVAL '12 hours'
          )
          AND NOT EXISTS (
            SELECT 1
              FROM qb_order_pipeline p
             WHERE p.reference_id = vb.id
               AND p.reference_type = 'vendor_bill'
               AND p.step = 'vendor_bill_payment_check'
               AND p.status IN ('pending', 'processing', 'submitted', 'waiting')
          )
        ORDER BY vb.qb_payment_checked_at ASC NULLS FIRST,
                 vb.due_date ASC NULLS LAST,
                 vb.created_at ASC
        LIMIT $1
     )
     INSERT INTO qb_order_pipeline (
       id, order_id, reference_id, reference_type, step, status,
       qb_txn_id, payload, created_at, updated_at
     )
     SELECT gen_random_uuid(), purchase_order_id, id, 'vendor_bill',
            'vendor_bill_payment_check', 'pending', qb_txn_id,
            jsonb_build_object(
              'vendor_bill_id', id,
              'txn_id', qb_txn_id,
              'ref_number', qb_ref_number,
              'automatic', true
            ),
            NOW(), NOW()
       FROM candidates
     RETURNING reference_id`,
    [BATCH_SIZE]
  );

  if (result.rowCount && result.rowCount > 0) {
    logger.info(
      `${LOG_PREFIX} queued ${result.rowCount} automatic payment check(s)`
    );
  }
}

export const config = {
  name: "qb-vendor-bill-payment-monitor",
  schedule: "17 * * * *",
};

/**
 * Promotes orphaned 'waiting' Sales Order pipeline rows to 'pending' so the
 * consolidator's pending-dispatch pass can send them to QuickBooks.
 *
 * Background: convert-force writes a step='sales_order' status='waiting' row at
 * CONVERSION time, but the cron that promotes it (qb-pos-sync section 1) keys
 * eligibility off order.created_at within a 24h ceiling. When a draft/estimate
 * is converted >24h after it was created, the order is already past that ceiling
 * the moment the waiting row exists → never promoted → stuck 'waiting' forever.
 * Neither consolidator pass rescues it (runWakeDependentsPass needs depends_on→
 * confirmed; runPendingDispatchPass only claims 'pending').
 *
 * Fix: promote by the PIPELINE ROW's own age (created_at > 1h), not the order's.
 * Guards:
 *   - depends_on IS NULL  (rows with a dependency are owned by the wake pass)
 *   - order not canceled
 *   - NO active invoice/sales_receipt for the order (a sale supersedes the SO;
 *     only 'failed'/'skipped' invoice rows do not block).
 *
 * Idempotent: WHERE status='waiting' guarantees rows already claimed are skipped.
 */

export type DbQueryRunner = {
  query: (text: string, params?: unknown[]) => Promise<{ rows: any[] }>;
};

export type RescuedSalesOrderRow = {
  id: string;
  order_id: string;
  medusa_ref_number: string | null;
};

export async function promoteStaleWaitingSalesOrders(
  db: DbQueryRunner
): Promise<RescuedSalesOrderRow[]> {
  const { rows } = await db.query(
    `UPDATE qb_order_pipeline so
        SET status = 'pending', updated_at = NOW()
       FROM "order" o
      WHERE so.order_id = o.id
        AND so.step = 'sales_order'
        AND so.status = 'waiting'
        AND so.depends_on IS NULL
        AND so.created_at <= NOW() - INTERVAL '1 hour'
        AND o.canceled_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM qb_order_pipeline inv
           WHERE inv.order_id = so.order_id
             AND inv.step IN ('invoice', 'sales_receipt')
             AND inv.status IN ('waiting', 'pending', 'processing', 'submitted', 'confirmed')
        )
      RETURNING so.id, so.order_id, so.medusa_ref_number`
  );
  return rows as RescuedSalesOrderRow[];
}

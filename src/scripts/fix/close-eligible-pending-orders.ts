/**
 * Close eligible pending orders (version-aware safety sweep)
 *
 * Finds every order still status='pending' that genuinely qualifies for native
 * completion and calls completeOrderWorkflow on it. Unlike the one-time
 * backfill-complete-pending-orders.ts, this script is SAFE TO RE-RUN: it has no
 * self-disable and only acts on orders that pass all guards at run time.
 *
 * Guards (identical to invoices/route.ts auto-complete, all version-aware):
 *   2. all CURRENT-version (oi.version = order.version) items fully fulfilled
 *   3. fully paid via non-voided pos_invoice (cents vs cents, 1¢ tolerance)
 *   4. no draft/open credit memos
 *   + must have at least one non-voided invoice, not a draft order
 *
 * Why this exists: order edits / void+re-fulfill leave stale lower-version
 * order_item rows (fulfilled_quantity=0). The old non-versioned fulfillment guard
 * counted them and blocked legitimately-complete orders (#1354, #1870, #2034,
 * #2055) from ever closing natively.
 *
 * DRY_RUN first (read-only, lists candidates):
 *   DRY_RUN=true env DATABASE_URL=$(grep ^DATABASE_URL= .env | cut -d= -f2-) \
 *   yarn medusa exec ./src/scripts/fix/close-eligible-pending-orders.ts
 *
 * Real run:
 *   env DATABASE_URL=$(grep ^DATABASE_URL= .env | cut -d= -f2-) \
 *   yarn medusa exec ./src/scripts/fix/close-eligible-pending-orders.ts
 */

import { Client } from "pg";

const DRY_RUN = process.env.DRY_RUN === "true";
const DELAY_MS = 500; // throttle the workflow engine

export default async function closeEligiblePendingOrders({
  container,
}: {
  container: any;
}) {
  const logger = container.resolve("logger") as any;
  const prefix = DRY_RUN ? "[DRY-RUN close-eligible]" : "[close-eligible]";

  logger.info(`${prefix} Scanning for eligible pending orders...`);

  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();

  try {
    const candidatesRes = await db.query<{ id: string; display_id: number }>(
      `SELECT o.id, o.display_id
       FROM "order" o
       WHERE o.status = 'pending'
         AND o.deleted_at IS NULL
         AND o.is_draft_order = false
         -- Guard 2: all CURRENT-version items fulfilled (ignore stale versions)
         AND NOT EXISTS (
           SELECT 1 FROM order_item oi
           WHERE oi.order_id = o.id AND oi.version = o.version
             AND oi.fulfilled_quantity < oi.quantity
         )
         -- Guard 3: fully paid. Deposit/BAMS-paid orders have amount_paid=0 (the
         -- captured deposit is never applied to the invoice row), so the paid side
         -- is max(SUM amount_paid cents, captured payment_collection ×100).
         AND GREATEST(
           (SELECT COALESCE(SUM(pi.amount_paid), 0)
              FROM pos_invoice pi WHERE pi.order_id = o.id AND pi.status != 'voided'),
           (SELECT COALESCE(ROUND(SUM(pc.captured_amount - COALESCE(pc.refunded_amount, 0)) * 100), 0)
              FROM order_payment_collection opc
              JOIN payment_collection pc ON pc.id = opc.payment_collection_id
             WHERE opc.order_id = o.id)
         ) >= (
           SELECT COALESCE(SUM(pi2.total), 1)
           FROM pos_invoice pi2 WHERE pi2.order_id = o.id AND pi2.status != 'voided'
         ) - 1
         -- Guard 4: no draft credit memos
         AND NOT EXISTS (
           SELECT 1 FROM pos_credit_memo cm
           WHERE cm.order_id = o.id AND cm.status NOT IN ('completed', 'voided')
         )
         -- must have at least one non-voided invoice
         AND EXISTS (
           SELECT 1 FROM pos_invoice pi3
           WHERE pi3.order_id = o.id AND pi3.status != 'voided'
         )
       ORDER BY o.display_id ASC`
    );

    const candidates = candidatesRes.rows;
    logger.info(`${prefix} ${candidates.length} eligible order(s) found`);
    for (const o of candidates) {
      logger.info(`${prefix}   → order #${o.display_id} (${o.id})`);
    }

    if (candidates.length === 0 || DRY_RUN) {
      logger.info(`${prefix} ${DRY_RUN ? "DRY_RUN — no changes made" : "nothing to do"}`);
      return;
    }

    const { completeOrderWorkflow } = await import("@medusajs/core-flows");
    let completed = 0;
    const skipped: { display_id: number; reason: string }[] = [];

    for (const order of candidates) {
      try {
        // re-check status right before acting (may have changed since the query)
        const fresh = await db.query<{ status: string }>(
          `SELECT status FROM "order" WHERE id = $1`,
          [order.id]
        );
        if (fresh.rows[0]?.status !== "pending") {
          skipped.push({
            display_id: order.display_id,
            reason: `already ${fresh.rows[0]?.status}`,
          });
          continue;
        }

        // ⚠️ input is { orderIds: string[] } — plural array
        await completeOrderWorkflow(container).run({
          input: { orderIds: [order.id] },
        });
        completed++;
        logger.info(
          `${prefix} ✅ [${completed}/${candidates.length}] order #${order.display_id} completed`
        );
      } catch (err: any) {
        skipped.push({
          display_id: order.display_id,
          reason: err?.message?.slice(0, 100) ?? "unknown error",
        });
        logger.warn(
          `${prefix} ⚠️  order #${order.display_id} skipped: ${err?.message?.slice(0, 100)}`
        );
      }
      await new Promise((r) => setTimeout(r, DELAY_MS));
    }

    logger.info(
      `${prefix} Done — ${completed} completed, ${skipped.length} skipped`
    );
    for (const s of skipped) {
      logger.info(`${prefix}   #${s.display_id}: ${s.reason}`);
    }
  } finally {
    await db.end();
  }
}

/**
 * Reconcile order_item.fulfilled_quantity from fulfillment_item data
 *
 * Fixes 147 orders (pre-May 2026) where fulfilled_quantity stayed at 0
 * despite having an active delivered fulfillment. This happened because
 * the old routes (pre-create-fulfillment-force) didn't update the counter.
 *
 * SAFE: only touches order_item.fulfilled_quantity (logistics counter).
 * Does NOT affect: invoices, amounts, payments, QB, revenue, reports.
 *
 * DRY_RUN=true  → preview only, no changes
 * DRY_RUN=false → apply the update
 *
 * Usage (sandbox):
 *   DATABASE_URL=postgresql://postgres:sandbox@localhost:5499/medusa \
 *   DRY_RUN=true yarn medusa exec ./src/scripts/migrations/reconcile-fulfilled-quantity.ts
 *
 * Usage (prod via Railway):
 *   env DATABASE_URL=$(grep ^DATABASE_URL= .env | cut -d= -f2-) \
 *   DRY_RUN=false yarn medusa exec ./src/scripts/migrations/reconcile-fulfilled-quantity.ts
 */

import { Client } from "pg";

const DRY_RUN = process.env.DRY_RUN !== "false"; // default = dry run for safety

export default async function reconcileFulfilledQuantity({
  container,
}: {
  container: any;
}) {
  const logger = container.resolve("logger") as any;
  const prefix = DRY_RUN ? "[DRY-RUN]" : "[reconcile-fulfilled-qty]";

  logger.info(`${prefix} Starting fulfilled_quantity reconciliation...`);
  if (DRY_RUN) logger.info(`${prefix} DRY_RUN mode — no changes will be made`);

  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();

  try {
    // ── Find affected rows ─────────────────────────────────────────────────
    const affectedRes = await db.query<{
      order_id: string;
      display_id: number;
      doc_num: string;
      item_id: string;
      current_qty: string;
      current_fulfilled: string;
      fi_qty: string;
      created_at: Date;
    }>(
      `SELECT
         o.id AS order_id,
         o.display_id,
         o.metadata->>'document_number' AS doc_num,
         oi.item_id,
         oi.quantity AS current_qty,
         oi.fulfilled_quantity AS current_fulfilled,
         COALESCE((
           SELECT SUM(fi.quantity)
           FROM order_fulfillment ofu2
           JOIN fulfillment f2 ON f2.id = ofu2.fulfillment_id
           JOIN fulfillment_item fi ON fi.fulfillment_id = f2.id
             AND fi.line_item_id = oi.item_id AND fi.deleted_at IS NULL
           WHERE ofu2.order_id = oi.order_id AND ofu2.deleted_at IS NULL
             AND f2.deleted_at IS NULL AND f2.canceled_at IS NULL AND f2.delivered_at IS NOT NULL
         ), 0) AS fi_qty,
         o.created_at
       FROM order_item oi
       JOIN "order" o ON o.id = oi.order_id
       WHERE oi.fulfilled_quantity < oi.quantity
         AND o.status = 'pending'
         AND o.deleted_at IS NULL
         AND o.is_draft_order = false
         AND EXISTS (
           SELECT 1 FROM order_fulfillment ofu
           JOIN fulfillment f ON f.id = ofu.fulfillment_id
           JOIN fulfillment_item fi ON fi.fulfillment_id = f.id
             AND fi.line_item_id = oi.item_id AND fi.deleted_at IS NULL
           WHERE ofu.order_id = oi.order_id AND ofu.deleted_at IS NULL
             AND f.deleted_at IS NULL AND f.canceled_at IS NULL AND f.delivered_at IS NOT NULL
         )
       ORDER BY o.created_at DESC, o.display_id`
    );

    const rows = affectedRes.rows;
    const orderCount = new Set(rows.map((r) => r.order_id)).size;

    logger.info(
      `${prefix} Found ${rows.length} order_item rows across ${orderCount} orders to reconcile`
    );

    if (rows.length === 0) {
      logger.info(`${prefix} Nothing to do.`);
      return;
    }

    // Show summary grouped by order
    const byOrder = new Map<string, typeof rows>();
    for (const r of rows) {
      if (!byOrder.has(r.order_id)) byOrder.set(r.order_id, []);
      byOrder.get(r.order_id)!.push(r);
    }

    logger.info(`${prefix} Affected orders (newest first):`);
    let shown = 0;
    for (const [, items] of byOrder) {
      const first = items[0];
      logger.info(
        `${prefix}   #${first.display_id} ${first.doc_num} (${new Date(first.created_at).toISOString().slice(0, 10)}) — ${items.length} item(s)`
      );
      if (++shown >= 15 && byOrder.size > 15) {
        logger.info(`${prefix}   ... and ${byOrder.size - 15} more`);
        break;
      }
    }

    if (DRY_RUN) {
      logger.info(`${prefix} DRY_RUN complete — ${rows.length} rows would be updated across ${orderCount} orders`);
      logger.info(`${prefix} Re-run with DRY_RUN=false to apply`);
      return;
    }

    // ── Apply update ───────────────────────────────────────────────────────
    const updateRes = await db.query(
      `UPDATE order_item oi
       SET
         fulfilled_quantity = LEAST(oi.quantity,
           COALESCE((
             SELECT SUM(fi.quantity)
             FROM order_fulfillment ofu
             JOIN fulfillment f ON f.id = ofu.fulfillment_id
             JOIN fulfillment_item fi ON fi.fulfillment_id = f.id
               AND fi.line_item_id = oi.item_id AND fi.deleted_at IS NULL
             WHERE ofu.order_id = oi.order_id AND ofu.deleted_at IS NULL
               AND f.deleted_at IS NULL AND f.canceled_at IS NULL
               AND f.delivered_at IS NOT NULL
           ), 0)
         ),
         raw_fulfilled_quantity = jsonb_build_object(
           'value', LEAST(oi.quantity,
             COALESCE((
               SELECT SUM(fi.quantity)
               FROM order_fulfillment ofu
               JOIN fulfillment f ON f.id = ofu.fulfillment_id
               JOIN fulfillment_item fi ON fi.fulfillment_id = f.id
                 AND fi.line_item_id = oi.item_id AND fi.deleted_at IS NULL
               WHERE ofu.order_id = oi.order_id AND ofu.deleted_at IS NULL
                 AND f.deleted_at IS NULL AND f.canceled_at IS NULL
                 AND f.delivered_at IS NOT NULL
             ), 0)
           )::text,
           'precision', 20
         )
       WHERE oi.fulfilled_quantity < oi.quantity
         AND oi.order_id IN (
           SELECT id FROM "order"
           WHERE status = 'pending' AND deleted_at IS NULL AND is_draft_order = false
         )
         AND EXISTS (
           SELECT 1 FROM order_fulfillment ofu
           JOIN fulfillment f ON f.id = ofu.fulfillment_id
           JOIN fulfillment_item fi ON fi.fulfillment_id = f.id
             AND fi.line_item_id = oi.item_id AND fi.deleted_at IS NULL
           WHERE ofu.order_id = oi.order_id AND ofu.deleted_at IS NULL
             AND f.deleted_at IS NULL AND f.canceled_at IS NULL
             AND f.delivered_at IS NOT NULL
         )`
    );

    logger.info(
      `${prefix} ✅ Updated ${updateRes.rowCount} order_item rows across ${orderCount} orders`
    );

    // ── Verify: how many orders now qualify for completeOrderWorkflow? ─────
    const nowQualify = await db.query<{ count: string }>(
      `SELECT COUNT(*) AS count
       FROM "order" o
       WHERE o.status = 'pending' AND o.deleted_at IS NULL AND o.is_draft_order = false
         AND NOT EXISTS (
           SELECT 1 FROM order_item oi WHERE oi.order_id = o.id
             AND oi.fulfilled_quantity < oi.quantity
         )
         AND EXISTS (
           SELECT 1 FROM payment_collection pc
           JOIN order_payment_collection opc ON opc.payment_collection_id = pc.id
           WHERE opc.order_id = o.id AND pc.status = 'completed'
         )
         AND NOT EXISTS (
           SELECT 1 FROM pos_credit_memo cm
           WHERE cm.order_id = o.id AND cm.status NOT IN ('completed', 'voided')
         )
         AND EXISTS (
           SELECT 1 FROM pos_invoice pi WHERE pi.order_id = o.id AND pi.status != 'voided'
         )`
    );

    logger.info(
      `${prefix} ✅ After fix: ${nowQualify.rows[0].count} orders now qualify for Medusa native completion`
    );

  } finally {
    await db.end();
  }
}

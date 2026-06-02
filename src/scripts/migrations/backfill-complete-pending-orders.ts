/**
 * Fix C: Backfill — complete qualifying pending orders in Medusa native
 *
 * Finds all orders that pass the 4 guards (fully fulfilled + fully paid +
 * no draft credit memos + status=pending) and calls completeOrderWorkflow
 * on each one sequentially.
 *
 * This is a ONE-TIME script. It self-disables by writing
 * store.metadata.completion_sweep_done = true after the first successful run.
 * Re-running after that is a no-op.
 *
 * Run in SANDBOX first:
 *   DATABASE_URL=postgresql://postgres:sandbox@localhost:5499/medusa \
 *   yarn medusa exec ./src/scripts/migrations/backfill-complete-pending-orders.ts
 *
 * Run in PROD (Railway, only after sandbox passes):
 *   env DATABASE_URL=$(grep ^DATABASE_URL= .env | cut -d= -f2-) \
 *   yarn medusa exec ./src/scripts/migrations/backfill-complete-pending-orders.ts
 *
 * Use DRY_RUN=true to preview which orders would be closed without touching anything:
 *   DRY_RUN=true DATABASE_URL=... yarn medusa exec ...
 */

import { Modules } from "@medusajs/utils";
import { Client } from "pg";

const DRY_RUN = process.env.DRY_RUN === "true";
const DELAY_MS = 500; // 500ms between orders — don't saturate workflow engine

export default async function backfillCompletePendingOrders({
  container,
}: {
  container: any;
}) {
  const logger = container.resolve("logger") as any;
  const prefix = DRY_RUN ? "[DRY-RUN]" : "[backfill-complete]";

  logger.info(`${prefix} Starting one-time pending order completion sweep...`);
  if (DRY_RUN) logger.info(`${prefix} DRY_RUN=true — no changes will be made`);

  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();

  try {
    // ── Self-disable check ───────────────────────────────────────────────────
    if (!DRY_RUN) {
      const storeModule = container.resolve(Modules.STORE) as any;
      const stores = await storeModule.listStores({}, { select: ["id", "metadata"] });
      const store = stores[0];
      if (store?.metadata?.completion_sweep_done) {
        logger.info(
          `${prefix} Already ran (completion_sweep_done=true on store). Skipping.`
        );
        return;
      }
    }

    // ── Find qualifying orders ───────────────────────────────────────────────
    const candidatesRes = await db.query<{ id: string; display_id: number }>(
      `SELECT o.id, o.display_id
       FROM "order" o
       WHERE o.status = 'pending'
         AND o.deleted_at IS NULL
         AND o.is_draft_order = false
         -- Guard 2: all items fulfilled
         AND NOT EXISTS (
           SELECT 1 FROM order_item oi
           WHERE oi.order_id = o.id AND oi.fulfilled_quantity < oi.quantity
         )
         -- Guard 3: fully paid (cents vs cents)
         AND (
           SELECT COALESCE(SUM(pi.amount_paid), 0)
           FROM pos_invoice pi WHERE pi.order_id = o.id AND pi.status != 'voided'
         ) >= (
           SELECT COALESCE(SUM(pi2.total), 1)
           FROM pos_invoice pi2 WHERE pi2.order_id = o.id AND pi2.status != 'voided'
         ) - 1
         -- Guard 4: no draft credit memos
         AND NOT EXISTS (
           SELECT 1 FROM pos_credit_memo cm
           WHERE cm.order_id = o.id AND cm.status NOT IN ('completed', 'voided')
         )
         -- Must have at least 1 invoice
         AND EXISTS (
           SELECT 1 FROM pos_invoice pi3
           WHERE pi3.order_id = o.id AND pi3.status != 'voided'
         )
       ORDER BY o.display_id ASC`
    );

    const candidates = candidatesRes.rows;
    logger.info(
      `${prefix} Found ${candidates.length} orders qualifying for completion`
    );

    if (candidates.length === 0) {
      logger.info(`${prefix} Nothing to do.`);
      return;
    }

    if (DRY_RUN) {
      logger.info(`${prefix} Would complete these orders:`);
      for (const o of candidates) {
        logger.info(`${prefix}   → order #${o.display_id} (${o.id})`);
      }
      logger.info(`${prefix} DRY_RUN complete — ${candidates.length} orders would be closed`);
      return;
    }

    // ── Process sequentially ─────────────────────────────────────────────────
    const { completeOrderWorkflow } = await import("@medusajs/core-flows");
    let completed = 0;
    let skipped = 0;
    const skippedOrders: { display_id: number; reason: string }[] = [];

    for (const order of candidates) {
      try {
        // Re-check order.status right before acting (may have changed since query)
        const freshCheck = await db.query<{ status: string }>(
          `SELECT status FROM "order" WHERE id = $1`,
          [order.id]
        );
        if (freshCheck.rows[0]?.status !== "pending") {
          skipped++;
          skippedOrders.push({
            display_id: order.display_id,
            reason: `status already ${freshCheck.rows[0]?.status}`,
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
        skipped++;
        const reason = err?.message?.slice(0, 100) ?? "unknown error";
        skippedOrders.push({ display_id: order.display_id, reason });
        logger.warn(
          `${prefix} ⚠️  order #${order.display_id} skipped: ${reason}`
        );
      }

      // 500ms between orders — don't saturate Medusa's workflow engine
      await new Promise((r) => setTimeout(r, DELAY_MS));
    }

    // ── Summary ──────────────────────────────────────────────────────────────
    logger.info(
      `${prefix} ✅ Sweep done — ${completed} completed, ${skipped} skipped`
    );
    if (skippedOrders.length > 0) {
      logger.info(`${prefix} Skipped orders:`);
      for (const s of skippedOrders) {
        logger.info(`${prefix}   #${s.display_id}: ${s.reason}`);
      }
    }

    // ── Self-disable ─────────────────────────────────────────────────────────
    const storeModule = container.resolve(Modules.STORE) as any;
    const stores = await storeModule.listStores({}, { select: ["id", "metadata"] });
    const store = stores[0];
    await storeModule.updateStores(store.id, {
      metadata: {
        ...(store.metadata ?? {}),
        completion_sweep_done: true,
        completion_sweep_at: new Date().toISOString(),
        completion_sweep_completed: completed,
        completion_sweep_skipped: skipped,
      },
    });
    logger.info(`${prefix} Self-disabled (store.metadata.completion_sweep_done = true)`);

  } finally {
    await db.end();
  }
}

/**
 * Reconcile & close DRIFTED pending orders (version-aware, proof-required)
 *
 * Closes the class of orders that get stuck `pending` forever because a
 * void+re-fulfill (or order edit) DRIFTED the current-version
 * order_item.fulfilled_quantity BELOW quantity even though the goods physically
 * went out. The void route reverts fulfilled/shipped quantities on purpose (so a
 * legit void→re-fulfill→re-ship works) — but when the user does NOT re-fulfill
 * (goods already delivered), the order is left drifted and never closes.
 *
 * SAFETY — only acts on an order when ALL hold (conservative, proof-required):
 *   1. status='pending', not a draft order
 *   2. fully INVOICED (Σ invoiced qty >= Σ current-version qty) AND fully PAID
 *      (max(Σ pos_invoice.amount_paid, captured payment_collection×100) >= invoiced)
 *   3. current version is DRIFTED: Σ fulfilled_quantity < Σ quantity
 *   4. PROOF the goods shipped: a PRIOR version was fully fulfilled
 *      (Σ fulfilled_quantity >= Σ quantity for some version < current)
 *   5. STALE: order.updated_at older than STALE_HOURS (default 24h) — avoids
 *      catching an order mid void→re-fulfill correction
 *   6. no draft/open credit memo
 *
 * For each: reconcile current-version fulfilled_quantity + raw_fulfilled_quantity
 * (+ delivered_quantity + raw) up to quantity, then completeOrderWorkflow, then
 * emit pos.order.fulfilled so Meili reindexes. Idempotent & re-runnable.
 *
 * DRY_RUN (read-only, lists candidates + what it would reconcile):
 *   DRY_RUN=true env DATABASE_URL=$(grep ^DATABASE_URL= .env|cut -d= -f2-) \
 *   yarn medusa exec ./src/scripts/fix/reconcile-and-close-drifted-orders.ts
 *
 * Real run: same without DRY_RUN=true.
 */
import { Client } from "pg";

const DRY_RUN = process.env.DRY_RUN === "true";
const STALE_HOURS = Number(process.env.STALE_HOURS ?? 24);
const DELAY_MS = 500;

export default async function reconcileAndCloseDrifted({
  container,
}: {
  container: any;
}) {
  const logger = container.resolve("logger") as any;
  const prefix = DRY_RUN ? "[DRY-RUN reconcile-drift]" : "[reconcile-drift]";
  logger.info(`${prefix} Scanning for drifted-but-shipped pending orders…`);

  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();

  try {
    const candidatesRes = await db.query<{
      id: string;
      display_id: number;
      docnum: string | null;
    }>(
      `SELECT o.id, o.display_id, o.metadata->>'document_number' AS docnum
       FROM "order" o
       WHERE o.status = 'pending'
         AND o.deleted_at IS NULL
         AND o.is_draft_order = false
         AND o.updated_at < NOW() - ($1 || ' hours')::interval
         -- (3) current version drifted: some line fulfilled < quantity
         AND EXISTS (
           SELECT 1 FROM order_item oi
           WHERE oi.order_id = o.id AND oi.version = o.version
             AND oi.fulfilled_quantity < oi.quantity
         )
         -- (4) PROOF: a prior version was fully fulfilled
         AND EXISTS (
           SELECT 1 FROM order_item oi2
           WHERE oi2.order_id = o.id AND oi2.version < o.version
           GROUP BY oi2.version
           HAVING SUM(oi2.fulfilled_quantity) >= SUM(oi2.quantity)
              AND SUM(oi2.quantity) > 0
         )
         -- (2a) fully invoiced (invoiced qty >= current-version qty)
         AND (
           SELECT COALESCE(SUM(pii.quantity), 0)
           FROM pos_invoice pi
           JOIN pos_invoice_item pii ON pii.invoice_id = pi.id AND pii.deleted_at IS NULL
           WHERE pi.order_id = o.id AND pi.status != 'voided'
         ) >= (
           SELECT COALESCE(SUM(oi.quantity), 0)
           FROM order_item oi WHERE oi.order_id = o.id AND oi.version = o.version
         )
         -- (2b) fully paid (cents; deposit-aware)
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
         -- (6) no draft/open credit memos
         AND NOT EXISTS (
           SELECT 1 FROM pos_credit_memo cm
           WHERE cm.order_id = o.id AND cm.status NOT IN ('completed', 'voided')
         )
       ORDER BY o.display_id ASC`,
      [String(STALE_HOURS)]
    );

    const candidates = candidatesRes.rows;
    logger.info(`${prefix} ${candidates.length} drifted candidate(s) found`);

    const { completeOrderWorkflow } = await import("@medusajs/core-flows");
    const eventBus = container.resolve("event_bus");
    let closed = 0;

    for (const o of candidates) {
      // Show / apply the reconcile per drifted current-version line
      const driftRows = await db.query<{
        id: string;
        quantity: string;
        fulfilled_quantity: string;
      }>(
        `SELECT oi.id, oi.quantity, oi.fulfilled_quantity
           FROM order_item oi
           JOIN "order" ord ON ord.id = oi.order_id AND ord.version = oi.version
          WHERE oi.order_id = $1 AND oi.fulfilled_quantity < oi.quantity`,
        [o.id]
      );
      const driftDesc = driftRows.rows
        .map((r) => `${r.fulfilled_quantity}→${r.quantity}`)
        .join(", ");
      logger.info(
        `${prefix}   → #${o.display_id} (${o.docnum ?? o.id}) reconcile [${driftDesc}]`
      );

      if (DRY_RUN) continue;

      // Reconcile fulfilled + delivered (col + raw BigNumber) up to quantity
      for (const r of driftRows.rows) {
        await db.query(
          `UPDATE order_item
              SET fulfilled_quantity = quantity,
                  raw_fulfilled_quantity = jsonb_set(raw_fulfilled_quantity, '{value}', to_jsonb(quantity::text)),
                  delivered_quantity = quantity,
                  raw_delivered_quantity = jsonb_set(raw_delivered_quantity, '{value}', to_jsonb(quantity::text)),
                  updated_at = NOW()
            WHERE id = $1`,
          [r.id]
        );
      }

      try {
        await completeOrderWorkflow(container).run({
          input: { orderIds: [o.id] },
        });
        try {
          await eventBus.emit({
            name: "pos.order.fulfilled",
            data: { id: o.id },
          });
        } catch {
          /* non-fatal */
        }
        closed++;
        logger.info(`${prefix}   ✅ #${o.display_id} reconciled + completed`);
      } catch (err: any) {
        logger.warn(
          `${prefix}   ⚠️ #${o.display_id} complete failed: ${err?.message?.slice(0, 120)}`
        );
      }
      await new Promise((res) => setTimeout(res, DELAY_MS));
    }

    logger.info(
      `${prefix} Done — ${DRY_RUN ? candidates.length + " would reconcile" : closed + " reconciled+closed"}`
    );
  } finally {
    await db.end();
  }
}

import { Modules } from "@medusajs/utils";

import { getDbPool } from "../api/utils/db-pool";

/**
 * Single source of truth for "is this order genuinely complete, and if so close
 * it natively in Medusa (status pending → completed)".
 *
 * WHY THIS EXISTS
 * The original auto-complete lived inline in invoices/route.ts as a ONE-SHOT,
 * non-durable `setTimeout(1500ms)` after invoice creation, with no retry. A
 * single missed attempt — a Railway redeploy killing the timer, or any transient
 * condition on that one run — leaves the order `pending` forever (orders
 * #2438/#2447/#2451/#2466 on 2026-06-30 — all fully invoiced + fully paid +
 * fully fulfilled, stuck purely because the single-shot trigger never retried).
 *
 * NOTE: completeOrderWorkflow (Medusa 2.13) does NOT validate payment/fulfillment
 * — completeOrder_ only rejects CANCELED. So gating correctness lives entirely in
 * the guards below; the workflow is just the status flip + `order.completed`
 * event + ordersCompleted hook (which local Meili/purchasing subscribers need).
 *
 * CONCURRENCY
 * completeOrderWorkflow is NOT idempotent at the event level — it re-completes an
 * already-completed order and emits a DUPLICATE `order.completed`. Event edges
 * (order.updated fires in bursts during an edit) can have two callers both pass
 * the `pending` guard. We therefore hold a SESSION-level pg advisory lock keyed
 * by order id across the guards + workflow, on a dedicated checked-out client,
 * and re-read `status='pending'` inside the lock. A txn-scoped lock would release
 * before the workflow runs; a pooled knex connection can be released while still
 * holding the lock — so we use getDbPool() + pg_try_advisory_lock + explicit
 * unlock in finally. A caller that loses the lock returns { reason: 'busy' } and
 * is harmlessly retried by the next edge.
 *
 * ALL CONDITIONS must hold before we complete — version-aware:
 *   - order exists, not deleted, not a draft order, still `pending`
 *   - at least one non-voided invoice (never auto-close an un-invoiced order)
 *   - every CURRENT-version (oi.version = order.version) item fully fulfilled
 *   - fully paid: max(SUM pos_invoice.amount_paid, SUM captured payment_collection
 *     ×100) >= SUM invoice total − 1¢. max() not additive: non-credit payments
 *     write BOTH pos_invoice.amount_paid AND a payment_collection, so summing
 *     double-counts and would falsely close underpaid orders.
 *   - no draft/open credit memos
 *
 * Never throws — returns a discriminated result so callers can log without
 * wrapping. A completeOrderWorkflow failure (transient) is captured as
 * { completed: false, reason } and self-heals on the next edge.
 */
export type MaybeCompleteResult =
  | { completed: true }
  | { completed: false; reason: string };

const LOG = "[auto-complete]";

export async function maybeCompleteOrder(
  container: any,
  orderId: string
): Promise<MaybeCompleteResult> {
  if (!orderId?.startsWith("order_")) {
    return { completed: false, reason: "invalid order id" };
  }

  const lockKey = `complete-order:${orderId}`;
  const pool = getDbPool();
  const client = await pool.connect();
  let locked = false;

  try {
    const lockRes = await client.query(
      `SELECT pg_try_advisory_lock(hashtext($1)) AS ok`,
      [lockKey]
    );
    if (!lockRes.rows[0]?.ok) {
      // another invocation is mid-completion for this order; the next edge retries
      return { completed: false, reason: "busy" };
    }
    locked = true;

    // Guard 1: order exists, live, not a draft, still pending (re-read in lock)
    const ordRes = await client.query(
      `SELECT status, is_draft_order, deleted_at FROM "order" WHERE id = $1`,
      [orderId]
    );
    const ord = ordRes.rows[0];
    if (!ord) return { completed: false, reason: "order not found" };
    if (ord.deleted_at) return { completed: false, reason: "deleted" };
    if (ord.is_draft_order) return { completed: false, reason: "draft order" };
    if (ord.status !== "pending") {
      return { completed: false, reason: `status=${ord.status}` };
    }

    // Must have at least one non-voided invoice (never auto-close un-invoiced)
    const invRes = await client.query(
      `SELECT COUNT(*)::int AS n FROM pos_invoice
        WHERE order_id = $1 AND status != 'voided'`,
      [orderId]
    );
    if ((invRes.rows[0]?.n ?? 0) === 0) {
      return { completed: false, reason: "no invoice" };
    }

    // Guard 2: every CURRENT-version item fully fulfilled
    const fulfillRes = await client.query(
      `SELECT COUNT(*) FILTER (WHERE oi.fulfilled_quantity < oi.quantity)::int AS unfulfilled
         FROM order_item oi
         JOIN "order" o ON o.id = oi.order_id
        WHERE oi.order_id = $1 AND oi.version = o.version`,
      [orderId]
    );
    if (Number(fulfillRes.rows[0]?.unfulfilled ?? 1) > 0) {
      return { completed: false, reason: "not fully fulfilled" };
    }

    // Guard 3: fully paid (cents vs cents, captured payment_collection fallback)
    const payRes = await client.query(
      `SELECT
         COALESCE((SELECT SUM(amount_paid) FROM pos_invoice
                    WHERE order_id = $1 AND status != 'voided'), 0) AS paid_cents,
         COALESCE((SELECT SUM(total) FROM pos_invoice
                    WHERE order_id = $1 AND status != 'voided'), 0) AS invoiced_cents,
         COALESCE((SELECT SUM(pc.captured_amount - COALESCE(pc.refunded_amount, 0))
                     FROM order_payment_collection opc
                     JOIN payment_collection pc ON pc.id = opc.payment_collection_id
                    WHERE opc.order_id = $1), 0) AS captured_dollars`,
      [orderId]
    );
    const paidCents = Number(payRes.rows[0]?.paid_cents ?? 0);
    const invoicedCents = Number(payRes.rows[0]?.invoiced_cents ?? 0);
    const capturedCents = Math.round(
      Number(payRes.rows[0]?.captured_dollars ?? 0) * 100
    );
    const effectivePaidCents = Math.max(paidCents, capturedCents);
    if (invoicedCents === 0 || effectivePaidCents < invoicedCents - 1) {
      return { completed: false, reason: "not fully paid" };
    }

    // Guard 4: no draft/open credit memos
    const cmRes = await client.query(
      `SELECT COUNT(*)::int AS n FROM pos_credit_memo
        WHERE order_id = $1 AND status NOT IN ('completed', 'voided')`,
      [orderId]
    );
    if ((cmRes.rows[0]?.n ?? 0) > 0) {
      return { completed: false, reason: "draft credit memo" };
    }

    // All conditions satisfied → complete natively in Medusa.
    // ⚠️ input shape is { orderIds: string[] } — plural array, NOT orderId.
    const { completeOrderWorkflow } = await import("@medusajs/core-flows");
    await completeOrderWorkflow(container).run({
      input: { orderIds: [orderId] },
    });

    // Emit custom event so purchasing-snapshot-on-event recomputes immediately.
    try {
      const eventBus = container.resolve(Modules.EVENT_BUS);
      await eventBus.emit({ name: "pos.order.fulfilled", data: { id: orderId } });
    } catch {
      /* non-fatal */
    }

    console.log(`${LOG} ✅ order ${orderId} completed`);
    return { completed: true };
  } catch (err: any) {
    // completeOrderWorkflow can throw transiently; the next order edge re-runs
    // this helper and closes the order once settled.
    const reason = `workflow: ${err?.message?.slice(0, 120) ?? "unknown error"}`;
    console.warn(`${LOG} ⚠️ order ${orderId} ${reason}`);
    return { completed: false, reason };
  } finally {
    let unlockFailed = false;
    if (locked) {
      try {
        await client.query(`SELECT pg_advisory_unlock(hashtext($1))`, [lockKey]);
      } catch {
        // Couldn't release the session lock — destroy this pooled connection so
        // it isn't reused while still holding the lock (would block this order).
        unlockFailed = true;
      }
    }
    client.release(unlockFailed);
  }
}

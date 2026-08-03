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
export type CompletionAttemptSource =
  | "customer_payment_applied"
  | "invoice_payment_recorded"
  | "order_completion_event"
  | "scheduled_reconciler"
  | "unspecified";

export type CompletionSkipReason =
  | "busy"
  | "deleted"
  | "draft_order"
  | "invalid_order_id"
  | "no_invoice"
  | "not_fully_fulfilled"
  | "not_fully_paid"
  | "open_credit_memo"
  | "order_not_found"
  | "status_not_pending"
  | "zero_total_unclassified"
  | "workflow_error";

export interface CompletionFacts {
  capturedCents?: number;
  detail?: string;
  effectivePaidCents?: number;
  invoiceCount?: number;
  invoicedCents?: number;
  openCreditMemos?: number;
  orderStatus?: string;
  paidCents?: number;
  unfulfilledItems?: number;
  warrantyZeroTotalInvoices?: number;
  zeroTotalInvoices?: number;
}

export type MaybeCompleteResult =
  | {
      completed: true;
      outcome: "completed";
      reason: null;
      facts: CompletionFacts;
    }
  | {
      completed: false;
      outcome: "skipped";
      reason: CompletionSkipReason;
      facts: CompletionFacts;
    };

export interface MaybeCompleteOptions {
  source?: CompletionAttemptSource;
}

const LOG = "[auto-complete]";

export async function maybeCompleteOrder(
  container: any,
  orderId: string,
  options: MaybeCompleteOptions = {}
): Promise<MaybeCompleteResult> {
  if (!orderId?.startsWith("order_")) {
    return {
      completed: false,
      outcome: "skipped",
      reason: "invalid_order_id",
      facts: {},
    };
  }

  const source = options.source ?? "unspecified";
  const lockKey = `complete-order:${orderId}`;
  const pool = getDbPool();
  const client = await pool.connect();
  let locked = false;
  const facts: CompletionFacts = {};

  const finish = async (
    result: MaybeCompleteResult
  ): Promise<MaybeCompleteResult> => {
    try {
      await client.query(
        `INSERT INTO order_completion_attempt
          (order_id, source, outcome, reason, facts)
         VALUES ($1, $2, $3, $4, $5::jsonb)`,
        [
          orderId,
          source,
          result.outcome,
          result.reason,
          JSON.stringify(result.facts),
        ]
      );
    } catch (auditError: unknown) {
      console.warn(
        `${LOG} audit unavailable for ${orderId}: ${(auditError as Error).message}`
      );
    }
    return result;
  };

  const skip = async (
    reason: CompletionSkipReason
  ): Promise<MaybeCompleteResult> =>
    finish({
      completed: false,
      outcome: "skipped",
      reason,
      facts: { ...facts },
    });

  try {
    const lockRes = await client.query(
      `SELECT pg_try_advisory_lock(hashtext($1)) AS ok`,
      [lockKey]
    );
    if (!lockRes.rows[0]?.ok) {
      // another invocation is mid-completion for this order; the next edge retries
      return skip("busy");
    }
    locked = true;

    // Guard 1: order exists, live, not a draft, still pending (re-read in lock)
    const ordRes = await client.query(
      `SELECT status, is_draft_order, deleted_at FROM "order" WHERE id = $1`,
      [orderId]
    );
    const ord = ordRes.rows[0];
    if (!ord) return skip("order_not_found");
    facts.orderStatus = String(ord.status);
    if (ord.deleted_at) return skip("deleted");
    if (ord.is_draft_order) return skip("draft_order");
    if (ord.status !== "pending") {
      return skip("status_not_pending");
    }

    // Must have at least one non-voided invoice (never auto-close un-invoiced)
    const invRes = await client.query(
      `SELECT COUNT(*)::int AS n FROM pos_invoice
        WHERE order_id = $1 AND status != 'voided' AND deleted_at IS NULL`,
      [orderId]
    );
    facts.invoiceCount = Number(invRes.rows[0]?.n ?? 0);
    if (facts.invoiceCount === 0) {
      return skip("no_invoice");
    }

    // Guard 2: every CURRENT-version item fully fulfilled
    const fulfillRes = await client.query(
      `SELECT COUNT(*) FILTER (WHERE oi.fulfilled_quantity < oi.quantity)::int AS unfulfilled
         FROM order_item oi
         JOIN "order" o ON o.id = oi.order_id
        WHERE oi.order_id = $1
          AND oi.version = o.version
          AND oi.deleted_at IS NULL`,
      [orderId]
    );
    facts.unfulfilledItems = Number(fulfillRes.rows[0]?.unfulfilled ?? 1);
    if (facts.unfulfilledItems > 0) {
      return skip("not_fully_fulfilled");
    }

    // Guard 3: fully paid (cents vs cents, captured payment_collection fallback)
    const payRes = await client.query(
      `SELECT
         COALESCE((SELECT SUM(amount_paid) FROM pos_invoice
                    WHERE order_id = $1 AND status != 'voided'
                      AND deleted_at IS NULL), 0) AS paid_cents,
         COALESCE((SELECT SUM(total) FROM pos_invoice
                    WHERE order_id = $1 AND status != 'voided'
                      AND deleted_at IS NULL), 0) AS invoiced_cents,
         COALESCE((SELECT COUNT(*) FROM pos_invoice
                    WHERE order_id = $1 AND status != 'voided'
                      AND deleted_at IS NULL AND total = 0), 0) AS zero_total_invoices,
         COALESCE((SELECT COUNT(*) FROM pos_invoice
                    WHERE order_id = $1 AND status != 'voided'
                      AND deleted_at IS NULL AND total = 0
                      AND status = 'paid'
                      AND metadata->'zero_total_evidence'->>'schema' = '1'
                      AND metadata->'zero_total_evidence'->>'reason' = 'warranty'
                      AND COALESCE(metadata->'zero_total_evidence'->>'confirmed_at', '') != ''
                      AND COALESCE(metadata->'zero_total_evidence'->>'confirmed_by', '') != ''
                      AND metadata->'zero_total_evidence'->>'source'
                            IN ('pos_confirmation', 'legacy_backfill')), 0)
           AS warranty_zero_total_invoices,
         COALESCE((SELECT SUM(pc.captured_amount - COALESCE(pc.refunded_amount, 0))
                     FROM order_payment_collection opc
                     JOIN payment_collection pc
                       ON pc.id = opc.payment_collection_id
                      AND pc.deleted_at IS NULL
                    WHERE opc.order_id = $1
                      AND opc.deleted_at IS NULL), 0) AS captured_dollars`,
      [orderId]
    );
    facts.paidCents = Number(payRes.rows[0]?.paid_cents ?? 0);
    facts.invoicedCents = Number(payRes.rows[0]?.invoiced_cents ?? 0);
    facts.zeroTotalInvoices = Number(
      payRes.rows[0]?.zero_total_invoices ?? 0
    );
    facts.warrantyZeroTotalInvoices = Number(
      payRes.rows[0]?.warranty_zero_total_invoices ?? 0
    );
    facts.capturedCents = Math.round(
      Number(payRes.rows[0]?.captured_dollars ?? 0) * 100
    );
    facts.effectivePaidCents = Math.max(facts.paidCents, facts.capturedCents);
    if (
      facts.invoicedCents === 0 &&
      (facts.zeroTotalInvoices !== facts.invoiceCount ||
        facts.warrantyZeroTotalInvoices !== facts.invoiceCount)
    ) {
      return skip("zero_total_unclassified");
    }
    if (facts.effectivePaidCents < facts.invoicedCents - 1) {
      return skip("not_fully_paid");
    }

    // Guard 4: no draft/open credit memos
    const cmRes = await client.query(
      `SELECT COUNT(*)::int AS n FROM pos_credit_memo
        WHERE order_id = $1
          AND status NOT IN ('completed', 'voided')
          AND deleted_at IS NULL`,
      [orderId]
    );
    facts.openCreditMemos = Number(cmRes.rows[0]?.n ?? 0);
    if (facts.openCreditMemos > 0) {
      return skip("open_credit_memo");
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
      await eventBus.emit({
        name: "pos.order.fulfilled",
        data: { id: orderId },
      });
    } catch {
      /* non-fatal */
    }

    console.log(`${LOG} ✅ order ${orderId} completed`);
    return finish({
      completed: true,
      outcome: "completed",
      reason: null,
      facts: { ...facts },
    });
  } catch (error: unknown) {
    // completeOrderWorkflow can throw transiently; the next order edge re-runs
    // this helper and closes the order once settled.
    facts.detail = (error as Error).message?.slice(0, 240) ?? "unknown error";
    console.warn(`${LOG} ⚠️ order ${orderId} workflow_error: ${facts.detail}`);
    return skip("workflow_error");
  } finally {
    let unlockFailed = false;
    if (locked) {
      try {
        await client.query(`SELECT pg_advisory_unlock(hashtext($1))`, [
          lockKey,
        ]);
      } catch {
        // Couldn't release the session lock — destroy this pooled connection so
        // it isn't reused while still holding the lock (would block this order).
        unlockFailed = true;
      }
    }
    client.release(unlockFailed);
  }
}

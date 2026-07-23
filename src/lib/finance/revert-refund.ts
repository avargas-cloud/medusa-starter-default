/**
 * revert-refund.ts — shared "Revert Refund → restore as store credit" logic.
 *
 * A recorded refund (customer_payment.status refunded/partial_refunded) is
 * reversed so the money returns to the customer as usable credit — the exact
 * state the payment would have had if the cashier had chosen "Store Credit".
 * This is NOT the void flow (qb-refunds/:id/void), which kills the credit.
 *
 * Called from TWO places with the same semantics:
 *  - the revert route (EASY case: nothing confirmed in QB → immediate revert)
 *  - the consolidator poll pass (MEDIUM case: revert deferred until the QB
 *    $0 apply ReceivePayment is deleted — the moment QB frees the credit)
 *
 * Uses the pg pool ($1 placeholders — NOT knex `?` style).
 */
import { getDbPool } from "../../api/utils/db-pool";
import { computeBatchDay } from "./batch-day";

export interface RevertRefundAudit {
  reason?: string | null;
  actorId?: string | null;
  source: "immediate" | "qb_cleanup_confirmed" | "manual_cleanup_attested";
}

export interface RevertRefundOutcome {
  ok: boolean;
  code?:
    | "NOT_FOUND"
    | "NOT_REFUNDED"
    | "ALREADY_REVERTED"
    | "LEGACY_UNSUPPORTED";
  newStatus?: string;
  restoredCents?: number;
}

/** Keys the refund flow wrote that must move into the audit block. */
const REFUND_META_KEYS = [
  "refund_amount",
  "refunded_at",
  "refund_notes",
  "refunded_by",
  "refund_txn_date",
] as const;

/** Keys the revert flow staged that must be cleared on completion. */
const REVERT_STAGE_KEYS = [
  "revert_state",
  "revert_reason",
  "revert_requested_by",
  "revert_requested_at",
] as const;

/**
 * Performs the Medusa-side reversal. Atomic claim on status — a concurrent
 * second call (double click, poller + manual confirm race) loses the claim
 * and returns ALREADY_REVERTED without touching anything.
 */
export async function performMedusaRefundRevert(
  paymentId: string,
  audit: RevertRefundAudit
): Promise<RevertRefundOutcome> {
  const pool = getDbPool();

  const { rows } = await pool.query(
    `SELECT id, type, status, amount, reference, received_at, batch_day,
            COALESCE(metadata, '{}'::jsonb) AS metadata
       FROM customer_payment
      WHERE id = $1 AND deleted_at IS NULL`,
    [paymentId]
  );
  const payment = rows[0];
  if (!payment) return { ok: false, code: "NOT_FOUND" };
  if (payment.type === "refund") return { ok: false, code: "LEGACY_UNSUPPORTED" };
  if (!["refunded", "partial_refunded"].includes(payment.status)) {
    return { ok: false, code: "NOT_REFUNDED" };
  }

  const meta = (payment.metadata ?? {}) as Record<string, unknown>;
  const amountCents = Number(payment.amount ?? 0);
  const restoredCents = Number(meta.refund_amount ?? amountCents) || 0;

  // ── New status ────────────────────────────────────────────────────────────
  let newStatus: string;
  if (payment.type === "credit_memo") {
    newStatus = "available";
  } else {
    // type='payment': derive from the LIVE active applications, never from
    // stale metadata (money fields can arrive as strings — coerce).
    const { rows: appRows } = await pool.query(
      `SELECT COALESCE(SUM(amount_applied), 0) AS applied
         FROM payment_application
        WHERE payment_id = $1 AND voided_at IS NULL AND deleted_at IS NULL`,
      [paymentId]
    );
    const applied = Number(appRows[0]?.applied ?? 0);
    newStatus =
      applied <= 0
        ? "available"
        : applied >= amountCents
          ? "applied"
          : "partially_applied";
  }

  // ── Metadata restructure (full-replace write — deep-merge can't delete) ──
  const newMeta: Record<string, unknown> = { ...meta };
  const archived: Record<string, unknown> = {};
  for (const k of REFUND_META_KEYS) {
    if (k in newMeta) {
      archived[k] = newMeta[k];
      delete newMeta[k];
    }
  }
  for (const k of REVERT_STAGE_KEYS) delete newMeta[k];

  const priorReversals = Array.isArray(meta.refund_reversals)
    ? (meta.refund_reversals as unknown[])
    : [];
  newMeta.refund_reversals = [
    ...priorReversals,
    {
      ...archived,
      prior_status: payment.status,
      restored_cents: restoredCents,
      reversed_at: new Date().toISOString(),
      reversed_by:
        audit.actorId ?? (meta.revert_requested_by as string | undefined) ?? null,
      reversed_reason:
        audit.reason ?? (meta.revert_reason as string | undefined) ?? null,
      revert_source: audit.source,
    },
  ];

  // ── batch_day restore ─────────────────────────────────────────────────────
  // qb-refunds/sync overwrote batch_day with the refund date; put the payment
  // back on its natural day (derived from received_at via the central helper).
  // If the refund was never synced (no refund_txn_date), leave batch_day alone.
  const newBatchDay = meta.refund_txn_date
    ? computeBatchDay(payment.received_at)
    : (payment.batch_day as string | null);

  const { rows: claimed } = await pool.query(
    `UPDATE customer_payment
        SET status = $2,
            metadata = $3::jsonb,
            batch_day = $4,
            updated_at = NOW()
      WHERE id = $1
        AND status IN ('refunded', 'partial_refunded')
      RETURNING id`,
    [paymentId, newStatus, JSON.stringify(newMeta), newBatchDay]
  );
  if (claimed.length === 0) return { ok: false, code: "ALREADY_REVERTED" };

  // ── CM-born refunds: put the parent invoice back on store-credit semantics ─
  // The CM completion flipped pos_invoice.status to refunded/partially_refunded
  // ONLY because the cashier chose "Refund"; the store-credit path leaves it
  // 'paid' (refunded_amount is incremented in BOTH paths and stays). Flip back
  // only when no OTHER completed refund-method CM exists on the order.
  if (payment.type === "credit_memo" && payment.reference) {
    try {
      const { rows: cmRows } = await pool.query(
        `SELECT id, order_id FROM pos_credit_memo
          WHERE credit_memo_number = $1 AND deleted_at IS NULL
          LIMIT 1`,
        [payment.reference]
      );
      const cm = cmRows[0];
      if (cm?.order_id) {
        const { rows: otherRows } = await pool.query(
          `SELECT COUNT(*)::int AS n FROM pos_credit_memo
            WHERE order_id = $1 AND id <> $2
              AND refund_method = 'refund' AND status = 'completed'
              AND deleted_at IS NULL`,
          [cm.order_id, cm.id]
        );
        if (Number(otherRows[0]?.n ?? 0) === 0) {
          await pool.query(
            `UPDATE pos_invoice
                SET status = 'paid', updated_at = NOW()
              WHERE order_id = $1
                AND status IN ('refunded', 'partially_refunded')
                AND deleted_at IS NULL`,
            [cm.order_id]
          );
        }
      }
    } catch {
      // Non-fatal: the credit is restored either way; invoice status is display.
    }
  }

  return { ok: true, newStatus, restoredCents };
}

/**
 * Marks the not-yet-run QB pipeline rows of a refund as skipped so a reverted
 * refund can never later mint its Write Check / $0 apply. Only touches rows
 * that have NOT reached QB (pending/waiting/failed) — confirmed rows are
 * history and in-flight rows must be waited out by the caller.
 */
export async function skipOpenRefundPipelineRows(
  paymentId: string,
  steps: string[],
  note: string
): Promise<number> {
  const pool = getDbPool();
  const { rows } = await pool.query(
    `UPDATE qb_order_pipeline
        SET status = 'skipped', error = $3, updated_at = NOW()
      WHERE reference_id = $1
        AND step = ANY($2)
        AND status IN ('pending', 'waiting', 'failed')
      RETURNING id`,
    [paymentId, steps, note]
  );
  return rows.length;
}

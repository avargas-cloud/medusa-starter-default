import { getDbPool } from "../../../api/utils/db-pool";
import type { WritePipelineRowInput } from "./types";
import { decideRetry, type RetryDecision } from "../retry-config";

/**
 * Writes a row to qb_order_pipeline.
 * Returns the row's UUID.
 *
 * Strategy:
 *   - status="pending"  → try UPDATE an existing "waiting" row first (cron picks up POS
 *                         delayed estimates by transitioning waiting→pending in-place);
 *                         if no waiting row, INSERT a new pending pre-flight row.
 *   - any other status  → try UPDATE the existing pending row first (preserves row ID,
 *                         no UI flicker); if no pending row exists, INSERT a new one.
 *
 * This means the row the user sees in the UI is updated in-place from
 * waiting → pending → submitted → confirmed/failed without disappearing.
 */
export async function writePipelineRow(
  input: WritePipelineRowInput
): Promise<string> {
  const pool = getDbPool();

  // For "waiting": upsert — update existing waiting row or fall through to INSERT.
  // Prevents duplicate waiting rows when upfront pipeline rows are written on invoice creation.
  // Supports orderId-only, referenceId-only, or both matches (null-safe).
  if (
    input.status === "waiting" &&
    (input.orderId || input.referenceId) &&
    input.step
  ) {
    const { rows: existingWaiting } = await pool.query(
      `UPDATE qb_order_pipeline
             SET medusa_ref_number = COALESCE($3, medusa_ref_number),
                 depends_on        = COALESCE($4, depends_on)
             WHERE step = $2 AND status = 'waiting'
               AND (
                 ($1::text IS NOT NULL AND order_id = $1::text AND ($5::text IS NULL OR reference_id = $5::text))
                 OR ($1::text IS NULL AND $5::text IS NOT NULL AND reference_id = $5::text)
               )
             RETURNING id`,
      [
        input.orderId ?? null,
        input.step,
        input.medusaRefNumber ?? null,
        input.dependsOn ?? null,
        input.referenceId ?? null,
      ]
    );
    if (existingWaiting.length > 0) return existingWaiting[0].id as string;
  }

  // For "pending": transition an existing "waiting" or "pending" row in-place.
  // Matches "waiting" (POS 1h-delay cron) and "pending" (retry endpoint already reset the row).
  // Supports orderId-only, referenceId-only, or both matches (null-safe).
  if (
    input.status === "pending" &&
    (input.orderId || input.referenceId) &&
    input.step
  ) {
    const { rows: fromWaiting } = await pool.query(
      `UPDATE qb_order_pipeline
             SET status            = 'pending',
                 updated_at        = NOW(),
                 medusa_ref_number = COALESCE($3, medusa_ref_number),
                 qb_ref_number     = COALESCE($4, qb_ref_number),
                 payload           = COALESCE($6::jsonb, payload)
             WHERE step = $2 AND status IN ('waiting', 'pending')
               AND (
                 ($1::text IS NOT NULL AND order_id = $1::text AND ($5::text IS NULL OR reference_id = $5::text))
                 OR ($1::text IS NULL AND $5::text IS NOT NULL AND reference_id = $5::text)
               )
             RETURNING id`,
      [
        input.orderId ?? null,
        input.step,
        input.medusaRefNumber ?? null,
        input.qbRefNumber ?? null,
        input.referenceId ?? null,
        input.payload ? JSON.stringify(input.payload) : null,
      ]
    );
    if (fromWaiting.length > 0) return fromWaiting[0].id as string;

    // Re-activation: if confirmed/failed/skipped/submitted, reset to pending (MOD/VOID/retry scenario).
    // 'submitted' is included to prevent duplicate INSERTs when the user saves an estimate that
    // is already in-flight (submitted but not yet confirmed by the bridge).
    // Preserves qb_txn_id (needed for Mod operations). Increments retry_count on failed.
    const { rows: reactivated } = await pool.query(
      `UPDATE qb_order_pipeline
             SET status            = 'pending',
                 updated_at        = NOW(),
                 error             = NULL,
                 failed_at         = NULL,
                 confirmed_at      = NULL,
                 submitted_at      = NULL,
                 bridge_op_id      = NULL,
                 qb_result         = NULL,
                 medusa_ref_number = COALESCE($3, medusa_ref_number),
                 payload           = COALESCE($5::jsonb, payload),
                 retry_count       = CASE WHEN status = 'failed' THEN retry_count + 1 ELSE retry_count END
             WHERE step = $2 AND status IN ('submitted', 'confirmed', 'failed', 'skipped')
               AND (
                 ($1::text IS NOT NULL AND order_id = $1::text AND ($4::text IS NULL OR reference_id = $4::text))
                 OR ($1::text IS NULL AND $4::text IS NOT NULL AND reference_id = $4::text)
               )
             RETURNING id`,
      [
        input.orderId ?? null,
        input.step,
        input.medusaRefNumber ?? null,
        input.referenceId ?? null,
        input.payload ? JSON.stringify(input.payload) : null,
      ]
    );
    if (reactivated.length > 0) return reactivated[0].id as string;
  }

  // For non-pending/non-waiting statuses: try to UPDATE the existing pending OR submitted row in-place.
  // Matching 'submitted' prevents duplicate INSERT when confirmed/failed write follows a submitted row.
  // Also match 'confirmed' when confirming — prevents duplicate INSERTs when both the handler and the
  // consolidator race to confirm the same row (e.g. payment step confirmed by consolidator first).
  // Supports orderId-only, referenceId-only, or both matches (null-safe).
  if (
    input.status !== "pending" &&
    input.status !== "waiting" &&
    (input.orderId || input.referenceId) &&
    input.step
  ) {
    const matchStatuses =
      input.status === "confirmed"
        ? `'processing', 'pending', 'submitted', 'confirmed'`
        : `'processing', 'pending', 'submitted'`;
    const { rows: updated } = await pool.query(
      `UPDATE qb_order_pipeline
             SET status            = $3,
                 updated_at        = NOW(),
                 bridge_op_id      = COALESCE($4, bridge_op_id),
                 qb_txn_id         = COALESCE($5, qb_txn_id),
                 qb_ref_number     = COALESCE($6, qb_ref_number),
                 medusa_ref_number  = COALESCE($7, medusa_ref_number),
                 error             = $8,
                 submitted_at  = CASE WHEN $3 = 'submitted' THEN NOW() ELSE submitted_at END,
                 confirmed_at  = CASE WHEN $3 = 'confirmed' THEN NOW() ELSE confirmed_at END,
                 failed_at     = CASE WHEN $3 = 'failed'    THEN NOW() ELSE failed_at    END
             WHERE step = $2 AND status IN (${matchStatuses})
               AND (
                 ($1::text IS NOT NULL AND order_id = $1::text AND ($9::text IS NULL OR reference_id = $9::text))
                 OR ($1::text IS NULL AND $9::text IS NOT NULL AND reference_id = $9::text)
               )
             RETURNING id`,
      [
        input.orderId ?? null,
        input.step,
        input.status,
        input.bridgeOpId ?? null,
        input.qbTxnId ?? null,
        input.qbRefNumber ?? null,
        input.medusaRefNumber ?? null,
        input.error ?? null,
        input.referenceId ?? null,
      ]
    );
    if (updated.length > 0) return updated[0].id as string;

    // Final idempotency guard for terminal statuses: if no pending/submitted row matched,
    // a prior callback may have already transitioned the row to the SAME terminal state
    // (e.g. two serialized save callbacks both end in 'failed' after a bridge outage).
    // Match the MOST RECENT row for this (order_id, reference_id, step) via a subquery
    // with LIMIT 1 so we never silently clobber multiple rows if the "1 row per
    // (order_id, step)" invariant is ever violated (by a DB manual insert, broken
    // migration, etc.). The id-based UPDATE is atomic.
    const { rows: idempotent } = await pool.query(
      `UPDATE qb_order_pipeline
             SET status            = $3,
                 updated_at        = NOW(),
                 bridge_op_id      = COALESCE($4, bridge_op_id),
                 qb_txn_id         = COALESCE($5, qb_txn_id),
                 qb_ref_number     = COALESCE($6, qb_ref_number),
                 medusa_ref_number  = COALESCE($7, medusa_ref_number),
                 error             = $8,
                 submitted_at  = CASE WHEN $3 = 'submitted' THEN NOW() ELSE submitted_at END,
                 confirmed_at  = CASE WHEN $3 = 'confirmed' THEN NOW() ELSE confirmed_at END,
                 failed_at     = CASE WHEN $3 = 'failed'    THEN NOW() ELSE failed_at    END
             WHERE id = (
               SELECT id FROM qb_order_pipeline
                 WHERE step = $2
                   AND (
                     ($1::text IS NOT NULL AND order_id = $1::text AND ($9::text IS NULL OR reference_id = $9::text))
                     OR ($1::text IS NULL AND $9::text IS NOT NULL AND reference_id = $9::text)
                   )
                 ORDER BY COALESCE(updated_at, created_at) DESC
                 LIMIT 1
             )
             RETURNING id`,
      [
        input.orderId ?? null,
        input.step,
        input.status,
        input.bridgeOpId ?? null,
        input.qbTxnId ?? null,
        input.qbRefNumber ?? null,
        input.medusaRefNumber ?? null,
        input.error ?? null,
        input.referenceId ?? null,
      ]
    );
    if (idempotent.length > 0) return idempotent[0].id as string;
  }

  // Final guard: if ANY row exists for this order+step (any status), reset it to pending instead
  // of inserting. This catches edge cases where the status-based checks above missed the row
  // (e.g. race conditions, unexpected status transitions, or status values not covered above).
  if (
    input.status === "pending" &&
    (input.orderId || input.referenceId) &&
    input.step
  ) {
    const { rows: claimed } = await pool.query(
      `SELECT id
         FROM qb_order_pipeline
        WHERE step = $2
          AND status = 'processing'
          AND (
            ($1::text IS NOT NULL AND order_id = $1::text AND ($3::text IS NULL OR reference_id = $3::text))
            OR ($1::text IS NULL AND $3::text IS NOT NULL AND reference_id = $3::text)
          )
        ORDER BY COALESCE(updated_at, created_at) DESC
        LIMIT 1`,
      [input.orderId ?? null, input.step, input.referenceId ?? null]
    );
    if (claimed.length > 0) return claimed[0].id as string;

    const { rows: anyExisting } = await pool.query(
      `UPDATE qb_order_pipeline
             SET status            = 'pending',
                 updated_at        = NOW(),
                 error             = NULL,
                 failed_at         = NULL,
                 submitted_at      = NULL,
                 bridge_op_id      = NULL,
                 qb_result         = NULL,
                 medusa_ref_number = COALESCE($3, medusa_ref_number),
                 retry_count       = CASE WHEN status = 'failed' THEN retry_count + 1 ELSE retry_count END
             WHERE step = $2
               AND status <> 'processing'
               AND (
                 ($1::text IS NOT NULL AND order_id = $1::text AND ($4::text IS NULL OR reference_id = $4::text))
                 OR ($1::text IS NULL AND $4::text IS NOT NULL AND reference_id = $4::text)
               )
             RETURNING id`,
      [
        input.orderId ?? null,
        input.step,
        input.medusaRefNumber ?? null,
        input.referenceId ?? null,
      ]
    );
    if (anyExisting.length > 0) return anyExisting[0].id as string;
  }

  // Fallback: INSERT a new row (no existing row found for this order+step)
  const { rows } = await pool.query(
    `INSERT INTO qb_order_pipeline
            (order_id, reference_id, reference_type, step, status, depends_on,
             bridge_op_id, retry_count, qb_txn_id, qb_ref_number, medusa_ref_number,
             qb_result, payload, error,
             submitted_at, confirmed_at, failed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,
             CASE WHEN $5 = 'submitted' THEN NOW() ELSE NULL END,
             CASE WHEN $5 = 'confirmed' THEN NOW() ELSE NULL END,
             CASE WHEN $5 = 'failed'    THEN NOW() ELSE NULL END)
         RETURNING id`,
    [
      input.orderId ?? null,
      input.referenceId ?? null,
      input.referenceType ?? null,
      input.step,
      input.status,
      input.dependsOn ?? null,
      input.bridgeOpId ?? null,
      input.retryCount ?? 0,
      input.qbTxnId ?? null,
      input.qbRefNumber ?? null,
      input.medusaRefNumber ?? null,
      input.qbResult ? JSON.stringify(input.qbResult) : null,
      input.payload ? JSON.stringify(input.payload) : null,
      input.error ?? null,
    ]
  );

  return rows[0].id as string;
}

/**
 * Marks any 'waiting' or 'pending' Sales Order pipeline row for the given order as 'skipped'.
 * Call this as soon as a POS Invoice or Sales Receipt is created for the order — the SO is no
 * longer needed and the cron should not create one.
 */
export async function skipSalesOrderPipelineRow(
  orderId: string
): Promise<void> {
  const pool = getDbPool();
  await pool.query(
    `UPDATE qb_order_pipeline
         SET status = 'skipped',
             error  = 'Superseded by Invoice/Sales Receipt — Sales Order not needed'
         WHERE order_id = $1
           AND step     = 'sales_order'
           AND status IN ('waiting', 'pending')`,
    [orderId]
  );
}

/**
 * Skips any waiting/pending `payment` or `apply_payment` pipeline rows for an order.
 * Use when a Sales Receipt supersedes them — the SR embeds the payment, so standalone
 * ReceivePayment rows are invalid.
 * Returns the number of rows skipped.
 */
export async function skipPendingPaymentRows(
  orderId: string,
  reason: string
): Promise<number> {
  const pool = getDbPool();
  // Also cancel 'submitted' rows where confirmed_at IS NULL — the QB bridge may
  // not have processed them yet (confirmed_at is set on bridge ack). This closes
  // the race window where handlePosPaymentCreated submits a row at T+100ms but
  // the invoice route only runs skipPendingPaymentRows at T+1300ms.
  const res = await pool.query(
    `UPDATE qb_order_pipeline
         SET status     = 'skipped',
             error      = $2,
             updated_at = NOW()
         WHERE order_id = $1
           AND step IN ('payment', 'apply_payment')
           AND (
             status IN ('waiting', 'pending')
             OR (status = 'submitted' AND confirmed_at IS NULL)
           )`,
    [orderId, reason]
  );
  return res.rowCount ?? 0;
}

/**
 * Apply-payment specific helper: transitions the existing apply_payment row
 * (matched by order_id + reference_id) to status='waiting' with the given
 * dependency, in-place. If no row exists, INSERTS a new waiting row.
 *
 * Used by handle-pos-payment-applied.ts when it discovers a missing dependency
 * (cpay TxnID for source / invoice TxnID for target). Replaces the old behavior
 * of calling writePipelineRow({status:'waiting'}) which only updated rows
 * already in 'waiting' status and silently INSERTED duplicates otherwise.
 *
 * Skips already-confirmed or skipped rows so we never resurrect terminal state.
 */
export async function requeueApplyPaymentWaiting(input: {
  orderId: string;
  referenceId: string;
  dependsOnRowId: string;
  medusaRefNumber?: string | null;
  referenceType?: string | null;
}): Promise<{ rowId: string | null; mode: "updated" | "inserted" | "noop" }> {
  const pool = getDbPool();
  const { rows: updated } = await pool.query(
    `UPDATE qb_order_pipeline
        SET status            = 'waiting',
            depends_on        = $3,
            updated_at        = NOW(),
            error             = NULL,
            failed_at         = NULL,
            submitted_at      = NULL,
            bridge_op_id      = NULL,
            medusa_ref_number = COALESCE($4, medusa_ref_number)
      WHERE step = 'apply_payment'
        AND order_id = $1
        AND reference_id = $2
        AND status NOT IN ('confirmed', 'skipped')
      RETURNING id`,
    [
      input.orderId,
      input.referenceId,
      input.dependsOnRowId,
      input.medusaRefNumber ?? null,
    ]
  );
  if (updated.length > 0) {
    return { rowId: updated[0].id as string, mode: "updated" };
  }

  // Check if a confirmed/skipped row already exists — never duplicate.
  const { rows: terminal } = await pool.query(
    `SELECT id FROM qb_order_pipeline
       WHERE step = 'apply_payment'
         AND order_id = $1
         AND reference_id = $2
         AND status IN ('confirmed', 'skipped')
       LIMIT 1`,
    [input.orderId, input.referenceId]
  );
  if (terminal.length > 0) {
    return { rowId: terminal[0].id as string, mode: "noop" };
  }

  const { rows: inserted } = await pool.query(
    `INSERT INTO qb_order_pipeline
        (order_id, reference_id, reference_type, step, status, depends_on, medusa_ref_number)
       VALUES ($1, $2, $5, 'apply_payment', 'waiting', $3, $4)
       RETURNING id`,
    [
      input.orderId,
      input.referenceId,
      input.dependsOnRowId,
      input.medusaRefNumber ?? null,
      input.referenceType ?? "customer_payment",
    ]
  );
  return { rowId: inserted[0].id as string, mode: "inserted" };
}

/**
 * Skips a single waiting/pending pipeline row by its customer_payment reference_id.
 * Used as a defensive cleanup when we detect a payment was absorbed by a Sales Receipt.
 */
export async function skipPaymentRowByReference(
  paymentId: string,
  reason: string
): Promise<number> {
  const pool = getDbPool();
  const res = await pool.query(
    `UPDATE qb_order_pipeline
         SET status     = 'skipped',
             error      = $2,
             updated_at = NOW()
         WHERE reference_id = $1
           AND reference_type = 'customer_payment'
           AND step IN ('payment', 'apply_payment')
           AND status IN ('waiting', 'pending')`,
    [paymentId, reason]
  );
  return res.rowCount ?? 0;
}

/**
 * Marks a submitted pipeline row as confirmed after the bridge returns success.
 */
export async function confirmPipelineRow(
  rowId: string,
  qbTxnId: string | null,
  qbRefNumber: string | null,
  qbResult: object | null
): Promise<void> {
  const pool = getDbPool();
  await pool.query(
    `UPDATE qb_order_pipeline
         SET status        = 'confirmed',
             updated_at    = NOW(),
             confirmed_at  = NOW(),
             qb_txn_id     = COALESCE($2, qb_txn_id),
             qb_ref_number = COALESCE($3, qb_ref_number),
             qb_result     = COALESCE($4::jsonb, qb_result),
             error         = NULL
         WHERE id = $1`,
    [rowId, qbTxnId, qbRefNumber, qbResult ? JSON.stringify(qbResult) : null]
  );
}

/**
 * Marks a pipeline row as failed.
 */
export async function failPipelineRow(
  rowId: string,
  error: string
): Promise<void> {
  const pool = getDbPool();
  await pool.query(
    `UPDATE qb_order_pipeline
         SET status       = 'failed',
             updated_at   = NOW(),
             failed_at    = NOW(),
             confirmed_at = NULL,
             error        = $2
         WHERE id = $1`,
    [rowId, error]
  );
}

/**
 * Retry-aware variant of `failPipelineRow` (Section 1.5.15 Phase 3b).
 *
 * Routes transient errors (3170 lock, 3210 EditSeq, network, parser failures,
 * etc.) to `status='failed'` with backoff via `next_retry_at`, so the
 * consolidator picks them up again on the next tick. Permanent errors and
 * exhausted retry budgets also land at `status='failed'`, but with
 * `next_retry_at = NULL`.
 *
 * Returns the decision so callers can branch (e.g., suppress cascade-fail
 * when the row is going to retry).
 */
export async function failOrRetryPipelineRow(
  rowId: string,
  error: string,
  retriesSoFar: number
): Promise<RetryDecision> {
  const decision = decideRetry({
    error: { message: error },
    retriesSoFar,
    hasNextRetryAt: true,
    hasFailedPermanent: false,
  });
  const pool = getDbPool();
  if (decision.nextRetryAt) {
    await pool.query(
      `UPDATE qb_order_pipeline
           SET status        = 'failed',
               retry_count   = $2,
               error         = $3,
               next_retry_at = $4,
               failed_at     = NOW(),
               confirmed_at  = NULL,
               updated_at    = NOW()
         WHERE id = $1`,
      [rowId, decision.newRetries, error, decision.nextRetryAt]
    );
  } else {
    await pool.query(
      `UPDATE qb_order_pipeline
           SET status        = 'failed',
               retry_count   = $2,
               error         = $3,
               failed_at     = NOW(),
               next_retry_at = NULL,
               confirmed_at  = NULL,
               updated_at    = NOW()
         WHERE id = $1`,
      [rowId, decision.newRetries, error]
    );
  }
  return { ...decision, newStatus: "failed" as const };
}

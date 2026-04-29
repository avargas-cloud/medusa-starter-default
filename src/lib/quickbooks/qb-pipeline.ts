import { getDbPool } from "../../api/utils/db-pool";

export type PipelineStep =
  | "customer"
  | "estimate"
  | "sales_order"
  | "sales_receipt"
  | "invoice"
  | "payment"
  | "apply_payment"
  | "credit_memo"
  | "write_check"
  | "refund_payment"
  | "void_estimate"
  | "void_invoice"
  | "void_sales_receipt"
  | "void_sales_order"
  | "invoice_update"
  | "credit_memo_mod"
  | "void_credit_memo"
  | "void_check"
  | "payment_method_change"
  | "transfer_customer"
  | "so_close"
  | "so_reopen"
  | "vendor_bill_void";

export type PipelineStatus =
  | "pending"
  | "submitted"
  | "confirmed"
  | "failed"
  | "skipped"
  | "waiting" // POS 1-hour delay window — cron will process when time arrives
  | "manual"; // qb_skip=true — order intentionally excluded from QB auto-sync

export interface WritePipelineRowInput {
  orderId?: string | null;
  referenceId?: string | null;
  referenceType?: string | null;
  step: PipelineStep;
  status: PipelineStatus;
  dependsOn?: string | null;
  bridgeOpId?: string | null;
  retryCount?: number;
  qbTxnId?: string | null;
  /** QB-assigned reference number (e.g. "E18024677", "6241", "PAY-2016") — only known after QB confirms */
  qbRefNumber?: string | null;
  /** Medusa document number (e.g. "E1271", "S10065", "INV-20001", "PAY-2016") — known at creation time */
  medusaRefNumber?: string | null;
  qbResult?: object | null;
  payload?: object | null;
  error?: string | null;
}

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
                 qb_ref_number     = COALESCE($4, qb_ref_number)
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
        ? `'pending', 'submitted', 'confirmed'`
        : `'pending', 'submitted'`;
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
 * Looks up a submitted pipeline row by bridge_op_id.
 * Used by the consolidator cron to match poll results back to rows.
 */
export async function findSubmittedRowByOpId(bridgeOpId: string): Promise<{
  id: string;
  orderId: string | null;
  referenceId: string | null;
  step: PipelineStep;
} | null> {
  const pool = getDbPool();
  const { rows } = await pool.query(
    `SELECT id, order_id, reference_id, step
         FROM qb_order_pipeline
         WHERE bridge_op_id = $1 AND status = 'submitted'
         LIMIT 1`,
    [bridgeOpId]
  );
  if (!rows[0]) return null;
  return {
    id: rows[0].id,
    orderId: rows[0].order_id,
    referenceId: rows[0].reference_id,
    step: rows[0].step,
  };
}

/**
 * Saves an EditSequence (and optionally TxnLineIDs) to the cache (upsert).
 * lineIds: productId → [TxnLineID, ...] mapping. Arrays support duplicate products on the same doc.
 * Call this after every QB response that contains an EditSequence.
 */
export async function cacheEditSequence(
  entityType: string,
  qbId: string,
  editSeq: string,
  lineIds?: Record<string, string[]> | null
): Promise<void> {
  if (!qbId || !editSeq) return;
  const pool = getDbPool();
  await pool.query(
    `INSERT INTO qb_edit_sequence_cache (entity_type, qb_id, edit_seq, line_ids, cached_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (entity_type, qb_id) DO UPDATE
             SET edit_seq  = EXCLUDED.edit_seq,
                 line_ids  = COALESCE(EXCLUDED.line_ids, qb_edit_sequence_cache.line_ids),
                 cached_at = NOW()`,
    [entityType, qbId, editSeq, lineIds ? JSON.stringify(lineIds) : null]
  );
}

/**
 * Retrieves a cached EditSequence and optional TxnLineIDs map, or null if not cached.
 * Normalizes old cache format (Record<string, string>) to current format (Record<string, string[]>).
 */
export async function getCachedEditSequence(
  entityType: string,
  qbId: string
): Promise<{
  editSeq: string;
  lineIds: Record<string, string[]> | null;
} | null> {
  const pool = getDbPool();
  const { rows } = await pool.query(
    `SELECT edit_seq, line_ids FROM qb_edit_sequence_cache WHERE entity_type = $1 AND qb_id = $2`,
    [entityType, qbId]
  );
  if (!rows[0]) return null;
  const rawLineIds = rows[0].line_ids as Record<
    string,
    string | string[]
  > | null;
  // Normalize: old cache entries stored string values; new format uses string[].
  const lineIds: Record<string, string[]> | null = rawLineIds
    ? Object.fromEntries(
        Object.entries(rawLineIds).map(([k, v]) => [
          k,
          Array.isArray(v) ? v : [v],
        ])
      )
    : null;
  return { editSeq: rows[0].edit_seq as string, lineIds };
}

/**
 * Polls a pipeline row until it leaves the 'submitted' state (i.e. reaches confirmed/failed/skipped).
 * Used by QB lock callbacks to ensure save2 only starts after save1 is confirmed,
 * so it can pick up the freshly-cached EditSequence and skip the GET round-trip.
 *
 * Returns 'confirmed', 'failed', 'skipped', 'timeout', or 'stale' if the row has been
 * stuck in 'submitted' (>15 min) or 'pending' (>10 min) based on updated_at.
 */
export async function pollUntilQbConfirmed(
  rowId: string,
  maxWaitMs = 5 * 60 * 1000, // 5 minutes default
  intervalMs = 3000
): Promise<"confirmed" | "failed" | "skipped" | "timeout" | "stale"> {
  const pool = getDbPool();
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const { rows } = await pool.query(
      `SELECT status, updated_at FROM qb_order_pipeline WHERE id = $1`,
      [rowId]
    );
    const row = rows[0] as { status: string; updated_at: string } | undefined;
    const status = row?.status;
    if (status === "confirmed") return "confirmed";
    if (status === "failed") return "failed";
    if (status === "skipped") return "skipped";

    // Stale detection: if the row has been stuck too long, don't wait forever
    if (row?.updated_at) {
      const updatedAt = new Date(row.updated_at).getTime();
      const ageMs = Date.now() - updatedAt;
      const isStaleSubmitted = status === "submitted" && ageMs > 15 * 60 * 1000;
      const isStalePending = status === "pending" && ageMs > 10 * 60 * 1000;
      if (isStaleSubmitted || isStalePending) {
        return "stale";
      }
    }

    // still 'submitted' or 'pending' — wait and retry
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return "timeout";
}

/**
 * Returns all in-flight (pending/submitted/waiting) pipeline rows for the given order
 * matching the provided steps. Used to detect races between creation and void operations.
 */
export async function findInFlightQbRows(
  orderId: string,
  steps: PipelineStep[]
): Promise<Array<{ id: string; step: PipelineStep; status: PipelineStatus }>> {
  if (steps.length === 0) return [];
  const pool = getDbPool();
  const placeholders = steps.map((_, i) => `$${i + 2}`).join(", ");
  const { rows } = await pool.query(
    `SELECT id, step, status FROM qb_order_pipeline
         WHERE order_id = $1
           AND step IN (${placeholders})
           AND status IN ('pending', 'submitted', 'waiting')
         ORDER BY created_at DESC`,
    [orderId, ...steps]
  );
  return rows.map((r) => ({
    id: r.id as string,
    step: r.step as PipelineStep,
    status: r.status as PipelineStatus,
  }));
}

/**
 * Marks a pipeline row as skipped by its UUID.
 * Use this to cancel a "waiting" or "pending" row that should never reach QB
 * (e.g. an estimate that was voided before the 1-hour cron window fired).
 */
export async function skipPipelineRowById(
  rowId: string,
  reason: string
): Promise<void> {
  const pool = getDbPool();
  await pool.query(
    `UPDATE qb_order_pipeline
         SET status = 'skipped',
             error  = $2
         WHERE id = $1
           AND status IN ('waiting', 'pending')`,
    [rowId, reason]
  );
}

/**
 * Returns all in-flight (pending/submitted/waiting) pipeline rows matched by referenceId
 * and referenceType. Used for credit memos and other reference-keyed documents.
 */
export async function findInFlightQbRowsByRef(
  referenceId: string,
  referenceType: string,
  steps: PipelineStep[]
): Promise<Array<{ id: string; step: PipelineStep }>> {
  if (steps.length === 0) return [];
  const pool = getDbPool();
  const placeholders = steps.map((_, i) => `$${i + 3}`).join(", ");
  const { rows } = await pool.query(
    `SELECT id, step FROM qb_order_pipeline
         WHERE reference_id = $1
           AND reference_type = $2
           AND step IN (${placeholders})
           AND status IN ('pending', 'submitted', 'waiting')
         ORDER BY created_at DESC`,
    [referenceId, referenceType, ...steps]
  );
  return rows.map((r) => ({
    id: r.id as string,
    step: r.step as PipelineStep,
  }));
}

/**
 * Returns the id of the most recent in-flight (pending/submitted/waiting) so_close or
 * so_reopen pipeline row for the given order, or null if none exists.
 * Used by toggle-close to create dependency chains and prevent race conditions.
 */
export async function findLastInFlightSoToggleRow(
  orderId: string
): Promise<string | null> {
  const pool = getDbPool();
  const { rows } = await pool.query(
    `SELECT id FROM qb_order_pipeline
         WHERE order_id = $1
           AND step IN ('so_close', 'so_reopen')
           AND status IN ('pending', 'submitted', 'waiting')
         ORDER BY created_at DESC
         LIMIT 1`,
    [orderId]
  );
  return rows[0]?.id ?? null;
}

/**
 * Invalidates an EditSequence cache entry (on 3210 conflict).
 */
export async function invalidateEditSequence(
  entityType: string,
  qbId: string
): Promise<void> {
  const pool = getDbPool();
  await pool.query(
    `DELETE FROM qb_edit_sequence_cache WHERE entity_type = $1 AND qb_id = $2`,
    [entityType, qbId]
  );
}

/**
 * Invalidates a cached EditSequence by entity type and QB transaction ID.
 * Used by stale row cleanup to prevent stale sequences from being used in
 * subsequent Mod operations after a row is marked failed due to inactivity.
 */
export async function invalidateEditSequenceCache(
  entityType: string,
  txnId: string
): Promise<void> {
  const pool = getDbPool();
  await pool.query(
    `DELETE FROM qb_edit_sequence_cache WHERE entity_type = $1 AND qb_id = $2`,
    [entityType, txnId]
  );
}

// ─── next_payload coalescing ─────────────────────────────────────────────────
//
// When a document is saved while a QB operation is already in-flight (submitted),
// we coalesce the new save instead of spawning a duplicate bridge call.
//
// Flow:
//   Save #1 → pending → submitted  (bridge processing)
//   Save #2 while submitted → next_payload = {coalescedAt} set on the same row
//                             → caller returns early, no bridge call
//   Consolidator confirms #1 → claimAndResetForResubmit → row reset to pending
//                             → appropriate handler called immediately
//   Row processes normally: pending → submitted → confirmed
//
// This keeps exactly 1 pipeline row per document at all times.

/**
 * Call at the start of every QB handler before touching the bridge.
 *
 * If a 'submitted' row already exists for this document+step:
 *   - Sets next_payload = {coalescedAt: <iso>} on that row (last-write-wins marker)
 *   - Returns true  → caller MUST return immediately without calling the bridge
 *
 * If no submitted row exists:
 *   - Returns false → caller proceeds normally
 *
 * Supports orderId-only, referenceId-only, or both (null-safe).
 */
export async function coalesceIfInFlight(
  orderId: string | null,
  referenceId: string | null,
  step: PipelineStep
): Promise<boolean> {
  if (!orderId && !referenceId) return false;
  const pool = getDbPool();
  const { rows } = await pool.query(
    `UPDATE qb_order_pipeline
         SET next_payload = $3::jsonb,
             updated_at   = NOW()
         WHERE step   = $2
           AND status  = 'submitted'
           AND (
             ($1::text IS NOT NULL AND order_id = $1::text
               AND ($4::text IS NULL OR reference_id = $4::text))
             OR
             ($1::text IS NULL AND $4::text IS NOT NULL AND reference_id = $4::text)
           )
         RETURNING id`,
    [
      orderId ?? null,
      step,
      JSON.stringify({ coalescedAt: new Date().toISOString() }),
      referenceId ?? null,
    ]
  );
  return rows.length > 0;
}

/**
 * Called by the consolidator immediately after confirming a pipeline row.
 *
 * Atomically reads next_payload and, if present, resets the same row back to
 * 'pending' so the coalesced save can be processed next.
 *
 * Returns true if there was a coalesced save pending (consolidator should
 * call the appropriate handler for this step right away).
 * Returns false if next_payload was NULL (nothing to do).
 */
export async function claimAndResetForResubmit(
  rowId: string
): Promise<boolean> {
  const pool = getDbPool();
  const { rows } = await pool.query(
    `UPDATE qb_order_pipeline
         SET status        = 'pending',
             next_payload  = NULL,
             bridge_op_id  = NULL,
             qb_result     = NULL,
             error         = NULL,
             submitted_at  = NULL,
             confirmed_at  = NULL,
             failed_at     = NULL,
             updated_at    = NOW(),
             retry_count   = 0
         WHERE id          = $1
           AND next_payload IS NOT NULL
         RETURNING id`,
    [rowId]
  );
  return rows.length > 0;
}

/**
 * Find the most recent in-flight pipeline row for a given document.
 * Returns the row if one exists with status 'submitted', or 'pending' with a
 * bridge_op_id (already dispatched). Pre-flight 'pending' rows without a
 * bridge_op_id are excluded — they haven't been sent to the bridge yet and
 * waiting on them would deadlock (the caller IS the one that will submit them).
 */
export async function findLatestInFlightRow(
  orderId: string,
  steps: string[]
): Promise<{
  id: string;
  status: string;
  created_at: string;
  updated_at: string;
} | null> {
  const pool = getDbPool();
  const { rows } = await pool.query(
    `SELECT id, status, created_at, updated_at
         FROM qb_order_pipeline
         WHERE order_id = $1 AND step = ANY($2)
           AND (status = 'submitted' OR (status = 'pending' AND bridge_op_id IS NOT NULL))
         ORDER BY created_at DESC
         LIMIT 1`,
    [orderId, steps]
  );
  return rows[0] ?? null;
}

/**
 * Idempotent upsert of a step='customer' pipeline row keyed by customer_id.
 *
 * Returns the UUID of the row — either the existing open row (pending/submitted/
 * waiting/confirmed) or a newly inserted pending one.
 *
 * If an existing row is in 'failed' state, it is resurrected to 'pending' and
 * retry_count incremented (same semantics as writePipelineRow for reactivation).
 *
 * medusaRefNumber stores the customer email for UI readability.
 */
export async function ensureCustomerPipelineRow(
  customerId: string,
  customerEmail: string | null
): Promise<string> {
  const pool = getDbPool();

  // 1) In-flight row (pending/submitted/waiting) or already confirmed → reuse.
  const { rows: existing } = await pool.query(
    `SELECT id, status FROM qb_order_pipeline
      WHERE step = 'customer' AND reference_id = $1
      ORDER BY created_at DESC
      LIMIT 1`,
    [customerId]
  );

  if (existing.length > 0) {
    const row = existing[0];
    if (row.status === "failed") {
      await pool.query(
        `UPDATE qb_order_pipeline
            SET status       = 'pending',
                error        = NULL,
                failed_at    = NULL,
                submitted_at = NULL,
                bridge_op_id = NULL,
                qb_result    = NULL,
                retry_count  = retry_count + 1,
                updated_at   = NOW(),
                medusa_ref_number = COALESCE($2, medusa_ref_number)
          WHERE id = $1`,
        [row.id, customerEmail]
      );
    }
    return row.id as string;
  }

  // 2) INSERT fresh pending row.
  const { rows } = await pool.query(
    `INSERT INTO qb_order_pipeline
        (reference_id, reference_type, step, status, medusa_ref_number)
     VALUES ($1, 'customer', 'customer', 'pending', $2)
     RETURNING id`,
    [customerId, customerEmail]
  );
  return rows[0].id as string;
}

/**
 * Preflight guard for QB handlers that require a customer to exist in QuickBooks.
 *
 * Reads customer.metadata.qb_list_id directly from the DB. If present, returns
 * `{ qbListId }` and the caller proceeds with the QB call.
 *
 * If absent:
 *   1. Enqueues / reuses a step='customer' pipeline row for the customer.
 *   2. Writes the caller's pipeline row as status='waiting' with depends_on set.
 *   3. Returns `{ waiting: true, customerRowId }` — the caller MUST return early.
 *
 * The consolidator processes step='customer' rows via ensureCustomerInQb,
 * and the "wake dependents" micro-pass reactivates the caller's waiting row
 * once the customer is confirmed.
 */
export type RequireQbCustomerResult =
  | { qbListId: string }
  | { waiting: true; customerRowId: string };

export async function requireQbCustomer(input: {
  customerId: string;
  orderId?: string | null;
  step: PipelineStep;
  selfReferenceId?: string | null;
  selfReferenceType?: string | null;
  selfMedusaRefNumber?: string | null;
}): Promise<RequireQbCustomerResult> {
  const pool = getDbPool();

  const { rows } = await pool.query(
    `SELECT email, metadata FROM customer WHERE id = $1 LIMIT 1`,
    [input.customerId]
  );
  const row = rows[0];
  const qbListId: string | null =
    (row?.metadata?.qb_list_id as string | undefined) ?? null;

  if (qbListId) {
    return { qbListId };
  }

  // Customer not in QB yet — enqueue creation, mark caller waiting.
  const email: string | null = (row?.email as string | undefined) ?? null;
  const customerRowId = await ensureCustomerPipelineRow(
    input.customerId,
    email
  );

  await writePipelineRow({
    orderId: input.orderId ?? null,
    referenceId: input.selfReferenceId ?? null,
    referenceType: input.selfReferenceType ?? null,
    step: input.step,
    status: "waiting",
    dependsOn: customerRowId,
    medusaRefNumber: input.selfMedusaRefNumber ?? null,
  });

  return { waiting: true, customerRowId };
}

/**
 * Wake-up pass: any 'waiting' row whose depends_on row has been 'confirmed'
 * is moved back to 'pending' so the consolidator picks it up on the next tick.
 *
 * Also clears submitted_at/failed_at/error if previously set. depends_on is kept
 * so the lineage is traceable in the UI.
 *
 * Returns the number of rows awakened.
 */
export async function wakeDependentsOfConfirmed(): Promise<number> {
  const pool = getDbPool();
  const { rowCount } = await pool.query(
    `UPDATE qb_order_pipeline w
        SET status       = 'pending',
            updated_at   = NOW(),
            error        = NULL,
            failed_at    = NULL,
            submitted_at = NULL,
            bridge_op_id = NULL
      FROM qb_order_pipeline d
     WHERE w.depends_on = d.id
       AND w.status     = 'waiting'
       AND d.status     = 'confirmed'`
  );
  return rowCount ?? 0;
}

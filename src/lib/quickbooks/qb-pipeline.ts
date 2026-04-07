import { getDbPool } from "../../api/utils/db-pool"

export type PipelineStep =
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
    | "void_credit_memo"
    | "void_check"
    | "payment_method_change"
    | "transfer_customer"
    | "so_close"
    | "so_reopen"

export type PipelineStatus =
    | "pending"
    | "submitted"
    | "confirmed"
    | "failed"
    | "skipped"
    | "waiting"     // POS 1-hour delay window — cron will process when time arrives
    | "manual"      // qb_skip=true — order intentionally excluded from QB auto-sync

export interface WritePipelineRowInput {
    orderId?: string | null
    referenceId?: string | null
    referenceType?: string | null
    step: PipelineStep
    status: PipelineStatus
    dependsOn?: string | null
    bridgeOpId?: string | null
    retryCount?: number
    qbTxnId?: string | null
    /** QB-assigned reference number (e.g. "E18024677", "6241", "PAY-2016") — only known after QB confirms */
    qbRefNumber?: string | null
    /** Medusa document number (e.g. "E1271", "S10065", "INV-20001", "PAY-2016") — known at creation time */
    medusaRefNumber?: string | null
    qbResult?: object | null
    payload?: object | null
    error?: string | null
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
export async function writePipelineRow(input: WritePipelineRowInput): Promise<string> {
    const pool = getDbPool()

    // For "waiting": upsert — update existing waiting row or fall through to INSERT.
    // Prevents duplicate waiting rows when upfront pipeline rows are written on invoice creation.
    // Supports orderId-only, referenceId-only, or both matches (null-safe).
    if (input.status === "waiting" && (input.orderId || input.referenceId) && input.step) {
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
            [input.orderId ?? null, input.step, input.medusaRefNumber ?? null, input.dependsOn ?? null, input.referenceId ?? null]
        )
        if (existingWaiting.length > 0) return existingWaiting[0].id as string
    }

    // For "pending": transition an existing "waiting" or "pending" row in-place.
    // Matches "waiting" (POS 1h-delay cron) and "pending" (retry endpoint already reset the row).
    // Supports orderId-only, referenceId-only, or both matches (null-safe).
    if (input.status === "pending" && (input.orderId || input.referenceId) && input.step) {
        const { rows: fromWaiting } = await pool.query(
            `UPDATE qb_order_pipeline
             SET status            = 'pending',
                 medusa_ref_number = COALESCE($3, medusa_ref_number),
                 qb_ref_number     = COALESCE($4, qb_ref_number)
             WHERE step = $2 AND status IN ('waiting', 'pending')
               AND (
                 ($1::text IS NOT NULL AND order_id = $1::text AND ($5::text IS NULL OR reference_id = $5::text))
                 OR ($1::text IS NULL AND $5::text IS NOT NULL AND reference_id = $5::text)
               )
             RETURNING id`,
            [input.orderId ?? null, input.step, input.medusaRefNumber ?? null, input.qbRefNumber ?? null, input.referenceId ?? null]
        )
        if (fromWaiting.length > 0) return fromWaiting[0].id as string

        // Re-activation: if confirmed/failed/skipped, reset to pending (MOD/VOID/retry scenario).
        // Preserves qb_txn_id (needed for Mod operations). Increments retry_count on failed.
        const { rows: reactivated } = await pool.query(
            `UPDATE qb_order_pipeline
             SET status            = 'pending',
                 error             = NULL,
                 failed_at         = NULL,
                 submitted_at      = NULL,
                 bridge_op_id      = NULL,
                 qb_result         = NULL,
                 medusa_ref_number = COALESCE($3, medusa_ref_number),
                 retry_count       = CASE WHEN status = 'failed' THEN retry_count + 1 ELSE retry_count END
             WHERE step = $2 AND status IN ('confirmed', 'failed', 'skipped')
               AND (
                 ($1::text IS NOT NULL AND order_id = $1::text AND ($4::text IS NULL OR reference_id = $4::text))
                 OR ($1::text IS NULL AND $4::text IS NOT NULL AND reference_id = $4::text)
               )
             RETURNING id`,
            [input.orderId ?? null, input.step, input.medusaRefNumber ?? null, input.referenceId ?? null]
        )
        if (reactivated.length > 0) return reactivated[0].id as string
    }

    // For non-pending/non-waiting statuses: try to UPDATE the existing pending OR submitted row in-place.
    // Matching 'submitted' prevents duplicate INSERT when confirmed/failed write follows a submitted row.
    // Also match 'confirmed' when confirming — prevents duplicate INSERTs when both the handler and the
    // consolidator race to confirm the same row (e.g. payment step confirmed by consolidator first).
    // Supports orderId-only, referenceId-only, or both matches (null-safe).
    if (input.status !== "pending" && input.status !== "waiting" && (input.orderId || input.referenceId) && input.step) {
        const matchStatuses = input.status === "confirmed"
            ? `'pending', 'submitted', 'confirmed'`
            : `'pending', 'submitted'`
        const { rows: updated } = await pool.query(
            `UPDATE qb_order_pipeline
             SET status            = $3,
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
                input.orderId         ?? null,
                input.step,
                input.status,
                input.bridgeOpId      ?? null,
                input.qbTxnId         ?? null,
                input.qbRefNumber     ?? null,
                input.medusaRefNumber ?? null,
                input.error           ?? null,
                input.referenceId     ?? null,
            ]
        )
        if (updated.length > 0) return updated[0].id as string
    }

    // Fallback: INSERT a new row (no existing pending row, or this is a pending pre-flight)
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
            input.orderId         ?? null,
            input.referenceId     ?? null,
            input.referenceType   ?? null,
            input.step,
            input.status,
            input.dependsOn       ?? null,
            input.bridgeOpId      ?? null,
            input.retryCount      ?? 0,
            input.qbTxnId         ?? null,
            input.qbRefNumber     ?? null,
            input.medusaRefNumber ?? null,
            input.qbResult        ? JSON.stringify(input.qbResult)  : null,
            input.payload         ? JSON.stringify(input.payload)   : null,
            input.error           ?? null,
        ]
    )

    return rows[0].id as string
}

/**
 * Marks any 'waiting' or 'pending' Sales Order pipeline row for the given order as 'skipped'.
 * Call this as soon as a POS Invoice or Sales Receipt is created for the order — the SO is no
 * longer needed and the cron should not create one.
 */
export async function skipSalesOrderPipelineRow(orderId: string): Promise<void> {
    const pool = getDbPool()
    await pool.query(
        `UPDATE qb_order_pipeline
         SET status = 'skipped',
             error  = 'Superseded by Invoice/Sales Receipt — Sales Order not needed'
         WHERE order_id = $1
           AND step     = 'sales_order'
           AND status IN ('waiting', 'pending')`,
        [orderId]
    )
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
    const pool = getDbPool()
    await pool.query(
        `UPDATE qb_order_pipeline
         SET status       = 'confirmed',
             confirmed_at = NOW(),
             qb_txn_id    = COALESCE($2, qb_txn_id),
             qb_ref_number = COALESCE($3, qb_ref_number),
             qb_result    = COALESCE($4::jsonb, qb_result),
             error        = NULL
         WHERE id = $1`,
        [rowId, qbTxnId, qbRefNumber, qbResult ? JSON.stringify(qbResult) : null]
    )
}

/**
 * Marks a pipeline row as failed.
 */
export async function failPipelineRow(rowId: string, error: string): Promise<void> {
    const pool = getDbPool()
    await pool.query(
        `UPDATE qb_order_pipeline
         SET status    = 'failed',
             failed_at = NOW(),
             error     = $2
         WHERE id = $1`,
        [rowId, error]
    )
}

/**
 * Looks up a submitted pipeline row by bridge_op_id.
 * Used by the consolidator cron to match poll results back to rows.
 */
export async function findSubmittedRowByOpId(bridgeOpId: string): Promise<{
    id: string
    orderId: string | null
    referenceId: string | null
    step: PipelineStep
} | null> {
    const pool = getDbPool()
    const { rows } = await pool.query(
        `SELECT id, order_id, reference_id, step
         FROM qb_order_pipeline
         WHERE bridge_op_id = $1 AND status = 'submitted'
         LIMIT 1`,
        [bridgeOpId]
    )
    if (!rows[0]) return null
    return {
        id:          rows[0].id,
        orderId:     rows[0].order_id,
        referenceId: rows[0].reference_id,
        step:        rows[0].step,
    }
}

/**
 * Saves an EditSequence to the cache (upsert).
 * Call this after every QB response that contains an EditSequence.
 */
export async function cacheEditSequence(
    entityType: string,
    qbId: string,
    editSeq: string
): Promise<void> {
    if (!qbId || !editSeq) return
    const pool = getDbPool()
    await pool.query(
        `INSERT INTO qb_edit_sequence_cache (entity_type, qb_id, edit_seq, cached_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (entity_type, qb_id) DO UPDATE
             SET edit_seq  = EXCLUDED.edit_seq,
                 cached_at = NOW()`,
        [entityType, qbId, editSeq]
    )
}

/**
 * Retrieves a cached EditSequence, or null if not cached.
 */
export async function getCachedEditSequence(
    entityType: string,
    qbId: string
): Promise<string | null> {
    const pool = getDbPool()
    const { rows } = await pool.query(
        `SELECT edit_seq FROM qb_edit_sequence_cache WHERE entity_type = $1 AND qb_id = $2`,
        [entityType, qbId]
    )
    return rows[0]?.edit_seq ?? null
}

/**
 * Returns all in-flight (pending/submitted/waiting) pipeline rows for the given order
 * matching the provided steps. Used to detect races between creation and void operations.
 */
export async function findInFlightQbRows(
    orderId: string,
    steps: PipelineStep[]
): Promise<Array<{ id: string; step: PipelineStep; status: PipelineStatus }>> {
    if (steps.length === 0) return []
    const pool = getDbPool()
    const placeholders = steps.map((_, i) => `$${i + 2}`).join(", ")
    const { rows } = await pool.query(
        `SELECT id, step, status FROM qb_order_pipeline
         WHERE order_id = $1
           AND step IN (${placeholders})
           AND status IN ('pending', 'submitted', 'waiting')
         ORDER BY created_at DESC`,
        [orderId, ...steps]
    )
    return rows.map((r) => ({ id: r.id as string, step: r.step as PipelineStep, status: r.status as PipelineStatus }))
}

/**
 * Marks a pipeline row as skipped by its UUID.
 * Use this to cancel a "waiting" or "pending" row that should never reach QB
 * (e.g. an estimate that was voided before the 1-hour cron window fired).
 */
export async function skipPipelineRowById(rowId: string, reason: string): Promise<void> {
    const pool = getDbPool()
    await pool.query(
        `UPDATE qb_order_pipeline
         SET status = 'skipped',
             error  = $2
         WHERE id = $1
           AND status IN ('waiting', 'pending')`,
        [rowId, reason]
    )
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
    if (steps.length === 0) return []
    const pool = getDbPool()
    const placeholders = steps.map((_, i) => `$${i + 3}`).join(", ")
    const { rows } = await pool.query(
        `SELECT id, step FROM qb_order_pipeline
         WHERE reference_id = $1
           AND reference_type = $2
           AND step IN (${placeholders})
           AND status IN ('pending', 'submitted', 'waiting')
         ORDER BY created_at DESC`,
        [referenceId, referenceType, ...steps]
    )
    return rows.map((r) => ({ id: r.id as string, step: r.step as PipelineStep }))
}

/**
 * Returns the id of the most recent in-flight (pending/submitted/waiting) so_close or
 * so_reopen pipeline row for the given order, or null if none exists.
 * Used by toggle-close to create dependency chains and prevent race conditions.
 */
export async function findLastInFlightSoToggleRow(orderId: string): Promise<string | null> {
    const pool = getDbPool()
    const { rows } = await pool.query(
        `SELECT id FROM qb_order_pipeline
         WHERE order_id = $1
           AND step IN ('so_close', 'so_reopen')
           AND status IN ('pending', 'submitted', 'waiting')
         ORDER BY created_at DESC
         LIMIT 1`,
        [orderId]
    )
    return rows[0]?.id ?? null
}

/**
 * Invalidates an EditSequence cache entry (on 3210 conflict).
 */
export async function invalidateEditSequence(
    entityType: string,
    qbId: string
): Promise<void> {
    const pool = getDbPool()
    await pool.query(
        `DELETE FROM qb_edit_sequence_cache WHERE entity_type = $1 AND qb_id = $2`,
        [entityType, qbId]
    )
}

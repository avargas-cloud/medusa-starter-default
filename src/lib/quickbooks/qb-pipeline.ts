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

export type PipelineStatus =
    | "pending"
    | "submitted"
    | "confirmed"
    | "failed"
    | "skipped"

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
    qbRefNumber?: string | null
    qbResult?: object | null
    payload?: object | null
    error?: string | null
}

/**
 * Inserts a new row into qb_order_pipeline.
 * Returns the inserted row's UUID.
 *
 * Before inserting, any existing 'pending' row for the same order_id+step is
 * deleted. This enables the Retry flow: the UI keeps the row visible as
 * 'pending', and when the handler re-submits it atomically swaps to 'submitted'.
 */
export async function writePipelineRow(input: WritePipelineRowInput): Promise<string> {
    const pool = getDbPool()

    // Swap out any pending row for the same order+step (retry transition)
    if (input.orderId && input.step) {
        await pool.query(
            `DELETE FROM qb_order_pipeline
             WHERE order_id = $1 AND step = $2 AND status = 'pending'`,
            [input.orderId, input.step]
        )
    }

    const { rows } = await pool.query(
        `INSERT INTO qb_order_pipeline
            (order_id, reference_id, reference_type, step, status, depends_on,
             bridge_op_id, retry_count, qb_txn_id, qb_ref_number, qb_result, payload, error,
             submitted_at, confirmed_at, failed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
             CASE WHEN $5 = 'submitted' THEN NOW() ELSE NULL END,
             CASE WHEN $5 = 'confirmed' THEN NOW() ELSE NULL END,
             CASE WHEN $5 = 'failed'    THEN NOW() ELSE NULL END)
         RETURNING id`,
        [
            input.orderId    ?? null,
            input.referenceId ?? null,
            input.referenceType ?? null,
            input.step,
            input.status,
            input.dependsOn  ?? null,
            input.bridgeOpId ?? null,
            input.retryCount ?? 0,
            input.qbTxnId    ?? null,
            input.qbRefNumber ?? null,
            input.qbResult   ? JSON.stringify(input.qbResult)  : null,
            input.payload    ? JSON.stringify(input.payload)   : null,
            input.error      ?? null,
        ]
    )

    return rows[0].id as string
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

/**
 * qb-sync-logger.ts
 *
 * Structured persistent logging for ALL QuickBooks operations.
 *
 * Covers 2 types of processes:
 *   1. Order lifecycle events (order.placed, payment_captured, fulfillment_created, etc.)
 *      → Infrequent (only on order action) — logger opens its own short-lived connection.
 *
 *   2. Admin panel batch syncs (inventory, prices, customers — scheduled or manual)
 *      → Jobs already have a pg Client open — pass it via `db` option to avoid extra connections.
 *
 * Resource cost: MINIMAL.
 *   - Order events: 2 short pg queries total per event (INSERT + UPDATE), on-demand connection.
 *   - Batch syncs: 0 extra connections if you pass an existing `db`. Just 2 queries per job run.
 *   - Table rows grow at ~2 rows per order event, ~2 per sync job. Tiny footprint.
 *
 * Usage (order events — auto-connection):
 *   const logId = await QbSyncLogger.start({ operation: 'sales_order', orderId, orderDisplayId, eventType: 'order.placed' })
 *   await QbSyncLogger.complete(logId, { qbTxnId, qbRefNumber, message: 'SO created' })
 *
 * Usage (batch sync — reuse existing connection):
 *   const logId = await QbSyncLogger.start({ operation: 'inventory_sync', syncType: 'inventory', triggeredBy: 'manual', db: client })
 *   await QbSyncLogger.complete(logId, { message: '120 items updated', db: client })
 */

import { Client } from "pg"
import * as os from "os"

/** Identifies where this code is running: Railway service name or local hostname */
const SERVER_LABEL: string = process.env.RAILWAY_SERVICE_NAME
    ? `Railway:${process.env.RAILWAY_SERVICE_NAME}`
    : process.env.RAILWAY_ENVIRONMENT
        ? `Railway:${process.env.RAILWAY_ENVIRONMENT}`
        : os.hostname()

// ─── Types ────────────────────────────────────────────────────────────────────

export type QbOperation =
    | "sales_order"
    | "estimate"
    | "payment"
    | "invoice"
    | "void_invoice"
    | "sales_receipt"
    | "cancel"
    | "customer_transfer"
    | "inventory_sync"
    | "price_sync"
    | "customer_sync"
    | "pos_sync"

export type QbLogStatus = "processing" | "completed" | "failed" | "skipped"

export interface QbLogStartOptions {
    operation: QbOperation
    /** For order lifecycle events */
    orderId?: string
    orderDisplayId?: number
    draftOrderId?: string
    eventType?: string           // 'order.placed', 'order.payment_captured', etc.
    /** For batch sync jobs */
    syncType?: string            // 'inventory' | 'price' | 'customer'
    triggeredBy?: "auto" | "manual" | "event"
    /** Human-readable description of what's starting */
    message?: string
    /** Extra data to store in jsonb metadata */
    metadata?: Record<string, any>
    /**
     * Pass an existing pg Client to reuse (no new connection opened).
     * Batch sync jobs should always pass their existing `client` here.
     * Order event subscribers can omit this — a short-lived connection is auto-created.
     */
    db?: Client
}

export interface QbLogCompleteOptions {
    message?: string
    qbTxnId?: string
    qbRefNumber?: string
    qbOperationId?: string
    metadata?: Record<string, any>
    /** Pass the same existing pg Client used in start(). */
    db?: Client
}

// ─── Internal helper ──────────────────────────────────────────────────────────

async function withDb<T>(externalDb: Client | undefined, fn: (db: Client) => Promise<T>): Promise<T> {
    if (externalDb) {
        // Reuse caller's connection — don't open or close anything
        return fn(externalDb)
    }
    // Auto-create a short-lived connection for order event subscribers
    const db = new Client({ connectionString: process.env.DATABASE_URL })
    await db.connect()
    try {
        return await fn(db)
    } finally {
        await db.end()
    }
}

// ─── QbSyncLogger ────────────────────────────────────────────────────────────

export const QbSyncLogger = {
    /**
     * Creates a new log entry with status='processing'.
     * Returns the UUID of the inserted row (use as `logId`).
     */
    async start(opts: QbLogStartOptions): Promise<string> {
        return withDb(opts.db, async (db) => {
            const { rows } = await db.query<{ id: string }>(`
                INSERT INTO qb_sync_log (
                    operation, status,
                    order_id, order_display_id, draft_order_id, event_type,
                    sync_type, triggered_by,
                    message, metadata, server_host, initiated_at
                ) VALUES (
                    $1, 'processing',
                    $2, $3, $4, $5,
                    $6, $7,
                    $8, $9, $10, NOW()
                )
                RETURNING id
            `, [
                opts.operation,
                opts.orderId ?? null,
                opts.orderDisplayId ?? null,
                opts.draftOrderId ?? null,
                opts.eventType ?? null,
                opts.syncType ?? null,
                opts.triggeredBy ?? "event",
                opts.message ?? null,
                opts.metadata ? JSON.stringify(opts.metadata) : null,
                SERVER_LABEL,
            ])
            return rows[0]!.id
        })
    },

    /**
     * Updates the log entry to status='completed'.
     * Automatically calculates `duration_ms` from `initiated_at`.
     */
    async complete(logId: string, opts: QbLogCompleteOptions = {}): Promise<void> {
        return withDb(opts.db, async (db) => {
            await db.query(`
                UPDATE qb_sync_log SET
                    status         = 'completed',
                    completed_at   = NOW(),
                    duration_ms    = EXTRACT(EPOCH FROM (NOW() - initiated_at)) * 1000,
                    message        = COALESCE($2, message),
                    qb_txn_id      = $3,
                    qb_ref_number  = $4,
                    qb_operation_id = $5,
                    metadata       = CASE
                                        WHEN $6::jsonb IS NOT NULL
                                        THEN COALESCE(metadata, '{}'::jsonb) || $6::jsonb
                                        ELSE metadata
                                     END
                WHERE id = $1
            `, [
                logId,
                opts.message ?? null,
                opts.qbTxnId ?? null,
                opts.qbRefNumber ?? null,
                opts.qbOperationId ?? null,
                opts.metadata ? JSON.stringify(opts.metadata) : null,
            ])
        })
    },

    /**
     * Updates the log entry to status='failed'.
     */
    async fail(logId: string, error: string, opts: { message?: string; metadata?: Record<string, any>; db?: Client } = {}): Promise<void> {
        return withDb(opts.db, async (db) => {
            await db.query(`
                UPDATE qb_sync_log SET
                    status       = 'failed',
                    completed_at = NOW(),
                    duration_ms  = EXTRACT(EPOCH FROM (NOW() - initiated_at)) * 1000,
                    error        = $2,
                    message      = COALESCE($3, message),
                    metadata     = CASE
                                        WHEN $4::jsonb IS NOT NULL
                                        THEN COALESCE(metadata, '{}'::jsonb) || $4::jsonb
                                        ELSE metadata
                                   END
                WHERE id = $1
            `, [
                logId,
                error,
                opts.message ?? null,
                opts.metadata ? JSON.stringify(opts.metadata) : null,
            ])
        })
    },

    /**
     * Updates the log entry to status='skipped'.
     */
    async skip(logId: string, reason: string, opts: { db?: Client } = {}): Promise<void> {
        return withDb(opts.db, async (db) => {
            await db.query(`
                UPDATE qb_sync_log SET
                    status       = 'skipped',
                    completed_at = NOW(),
                    duration_ms  = EXTRACT(EPOCH FROM (NOW() - initiated_at)) * 1000,
                    message      = $2
                WHERE id = $1
            `, [logId, reason])
        })
    },

    /**
     * Convenience wrapper: auto start → complete/fail.
     * Note: wrap() always uses its own auto-connection (no `db` passthrough).
     * For batch jobs, prefer calling start()/complete()/fail() directly with `db`.
     */
    async wrap<T extends QbLogCompleteOptions>(
        startOpts: QbLogStartOptions,
        fn: (logId: string) => Promise<T | null>
    ): Promise<{ logId: string; result: T | null; error?: string }> {
        // Ensure `db` is not passed to the internal start call, as wrap manages its own connection
        const logId = await this.start({ ...startOpts, db: undefined })
        try {
            const result = await fn(logId)
            if (result !== null) {
                await this.complete(logId, { ...result, db: undefined })
            }
            return { logId, result }
        } catch (err: any) {
            // Ensure `db` is not passed to the internal fail call
            await this.fail(logId, err.message, { db: undefined })
            return { logId, result: null, error: err.message }
        }
    },

    /**
     * Persists the bridge operationId to the log entry mid-flight — call this
     * immediately after queueing (before polling starts) so the recovery job
     * can resume polling if the server restarts while waiting.
     */
    async setOperationId(logId: string, operationId: string): Promise<void> {
        return withDb(undefined, async (db) => {
            await db.query(
                `UPDATE qb_sync_log SET qb_operation_id = $2 WHERE id = $1`,
                [logId, operationId]
            )
        })
    },

    /**
     * Delete log entries older than `retentionDays` days.
     * Called by quickbooks-daily-sync.ts as a fallback when pg_cron is not available.
     * Default: 90 days retention.
     */
    async cleanup(retentionDays = 90, db?: Client): Promise<number> {
        return withDb(db, async (conn) => {
            const result = await conn.query(
                `DELETE FROM qb_sync_log WHERE initiated_at < NOW() - INTERVAL '${retentionDays} days'`
            )
            return result.rowCount ?? 0
        })
    },
}

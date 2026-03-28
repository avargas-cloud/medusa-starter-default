import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { Client } from "pg"
import { bridgeFetch } from "../../../../lib/quickbooks/client/core"
import { ContainerRegistrationKeys, Modules } from "@medusajs/utils"

/**
 * GET /admin/quickbooks/pipeline
 *
 * Returns rows from qb_order_pipeline — the real-time QB operations queue.
 *
 * Query params:
 *   limit        — rows per page (default 30, max 100)
 *   offset       — pagination (default 0)
 *   status       — 'pending' | 'submitted' | 'confirmed' | 'failed' | 'skipped'
 *   step         — 'estimate' | 'sales_order' | 'invoice' | 'payment' | 'apply_payment'
 *                  | 'sales_receipt' | 'credit_memo' | 'write_check'
 *   reference_id — filter by order_id or reference_id
 *
 * POST /admin/quickbooks/pipeline/:id/retry
 *   Resets a failed row back to 'pending' so the cron picks it up again.
 */

export async function GET(
    req: MedusaRequest,
    res: MedusaResponse
): Promise<void> {
    const client = new Client({ connectionString: process.env.DATABASE_URL })

    try {
        await client.connect()

        const limit  = Math.min(parseInt(req.query.limit  as string) || 30, 100)
        const offset = parseInt(req.query.offset as string) || 0
        const status = req.query.status       as string | undefined
        const step   = req.query.step         as string | undefined
        const refId  = req.query.reference_id as string | undefined

        // Auto-timeout: submitted rows older than 10 min with no bridge_op_id → failed
        await client.query(`
            UPDATE qb_order_pipeline
            SET status    = 'failed',
                failed_at = NOW(),
                error     = 'Submission timed out — no bridge_op_id recorded'
            WHERE status = 'submitted'
              AND bridge_op_id IS NULL
              AND submitted_at < NOW() - INTERVAL '10 minutes'
        `)

        // Auto-timeout: submitted rows with bridge_op_id older than 15 min (QBWC not responding) → failed
        await client.query(`
            UPDATE qb_order_pipeline
            SET status    = 'failed',
                failed_at = NOW(),
                error     = 'QBWC did not respond within 15 minutes — QuickBooks Desktop may be offline or QBWC disconnected'
            WHERE status = 'submitted'
              AND bridge_op_id IS NOT NULL
              AND submitted_at < NOW() - INTERVAL '15 minutes'
        `)

        // Auto-timeout: pending rows older than 30 min (handler never re-submitted) → failed
        await client.query(`
            UPDATE qb_order_pipeline
            SET status    = 'failed',
                failed_at = NOW(),
                error     = 'Operation stuck in pending — handler did not re-submit within 30 minutes'
            WHERE status = 'pending'
              AND created_at < NOW() - INTERVAL '30 minutes'
        `)

        const conditions: string[] = []
        const values: any[] = []
        let p = 1

        if (status) { conditions.push(`p.status = $${p++}`); values.push(status) }
        if (step)   { conditions.push(`p.step = $${p++}`);   values.push(step) }
        if (refId)  {
            conditions.push(`(p.order_id = $${p} OR p.reference_id = $${p})`)
            values.push(refId); p++
        }

        const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""

        const { rows } = await client.query(`
            SELECT
                p.id,
                p.order_id,
                p.reference_id,
                p.reference_type,
                p.step,
                p.status,
                p.depends_on,
                p.bridge_op_id,
                p.retry_count,
                p.qb_txn_id,
                p.qb_ref_number,
                p.error,
                p.created_at,
                p.submitted_at,
                p.confirmed_at,
                p.failed_at,
                -- Include parent step name for context
                dep.step AS depends_on_step,
                dep.status AS depends_on_status
            FROM qb_order_pipeline p
            LEFT JOIN qb_order_pipeline dep ON dep.id = p.depends_on
            ${where}
            ORDER BY p.created_at DESC
            LIMIT $${p} OFFSET $${p + 1}
        `, [...values, limit, offset])

        const countResult = await client.query(
            `SELECT COUNT(*) FROM qb_order_pipeline p ${where}`,
            values
        )
        const total = parseInt(countResult.rows[0].count)

        // Summary counts per status (for header badges)
        const { rows: summary } = await client.query(`
            SELECT status, COUNT(*) AS count
            FROM qb_order_pipeline
            GROUP BY status
        `)
        const counts: Record<string, number> = {}
        for (const row of summary) {
            counts[row.status] = parseInt(row.count)
        }

        res.json({
            pipeline: rows,
            pagination: { total, limit, offset, hasMore: offset + rows.length < total },
            counts,
        })

    } catch (err: any) {
        console.error("[QB Pipeline GET] Error:", err)
        res.status(500).json({ error: "Failed to fetch pipeline" })
    } finally {
        await client.end()
    }
}

export async function POST(
    req: MedusaRequest,
    res: MedusaResponse
): Promise<void> {
    // POST /admin/quickbooks/pipeline?action=retry&id=<uuid>
    // Re-submits a failed operation immediately:
    //   1. Reads the row (step, order_id, reference_id)
    //   2. Deletes it (handler will create a fresh submitted row)
    //   3. Resets qb_sync_status on the entity so the guard allows re-sync
    //   4. Calls the appropriate handler in the background
    const rowId  = req.query.id     as string | undefined
    const action = req.query.action as string | undefined

    if (!rowId || action !== "retry") {
        res.status(400).json({ error: "Requires ?action=retry&id=<uuid>" })
        return
    }

    const logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER)
    const LOG_PREFIX = "[QB Pipeline Retry]"

    const client = new Client({ connectionString: process.env.DATABASE_URL })
    try {
        await client.connect()

        // 1. Read the row (failed or stuck-pending)
        const { rows } = await client.query(
            `SELECT id, step, order_id, reference_id, reference_type, retry_count
             FROM qb_order_pipeline WHERE id = $1 AND status IN ('failed', 'pending')`,
            [rowId]
        )
        if (!rows.length) {
            res.status(404).json({ error: "Row not found or not in retryable status (must be failed or pending)" })
            return
        }
        const row = rows[0]

        // 2. Reset row to 'pending' so it stays visible in the UI while the handler runs.
        //    writePipelineRow will atomically swap it to 'submitted' once the bridge_op_id is known.
        await client.query(
            `UPDATE qb_order_pipeline
             SET status       = 'pending',
                 error        = NULL,
                 failed_at    = NULL,
                 submitted_at = NULL,
                 bridge_op_id = NULL,
                 qb_txn_id    = NULL,
                 qb_ref_number = NULL,
                 retry_count  = retry_count + 1
             WHERE id = $1`,
            [rowId]
        )

        // 3. Reset qb_sync_status on the entity so guards allow re-sync
        if (row.order_id) {
            try {
                const orderModule = req.scope.resolve(Modules.ORDER)
                const order = await orderModule.retrieveOrder(row.order_id)
                const meta = (order as any).metadata || {}
                // Only reset if it's in a blocking non-error state
                const currentStatus = meta.qb_sync_status
                if (currentStatus && currentStatus !== "error" && currentStatus !== "voided") {
                    await orderModule.updateOrders(row.order_id, {
                        metadata: { ...meta, qb_sync_status: "error" }
                    })
                }
            } catch (metaErr: any) {
                logger.warn(`${LOG_PREFIX} Could not reset qb_sync_status: ${metaErr.message}`)
            }
        }

        // 4. Fire the appropriate handler in the background
        const retryCount = (row.retry_count ?? 0) + 1
        logger.info(`${LOG_PREFIX} Retrying step=${row.step} order=${row.order_id} retry#${retryCount}`)

        ;(async () => {
            try {
                const orderModule   = req.scope.resolve(Modules.ORDER)
                const customerModule = req.scope.resolve(Modules.CUSTOMER)

                switch (row.step) {
                    case "estimate": {
                        const { handleDraftOrderCreated } = require("../../../../subscribers/qb-draft-order-subscriber")
                        await handleDraftOrderCreated({ id: row.order_id }, req.scope, logger, true)
                        break
                    }
                    case "sales_order": {
                        const { handleOrderPlaced } = require("../../../../lib/quickbooks/handlers/handle-order-placed")
                        await handleOrderPlaced({ id: row.order_id }, orderModule, customerModule, req.scope, logger, false)
                        break
                    }
                    case "invoice": {
                        const { handleFulfillmentCreated } = require("../../../../lib/quickbooks/handlers/handle-fulfillment-created")
                        await handleFulfillmentCreated(
                            { order_id: row.order_id, fulfillment_id: row.reference_id, invoice_id: row.reference_id },
                            orderModule, customerModule, req.scope, logger
                        )
                        break
                    }
                    case "sales_receipt": {
                        const { handleSalesReceiptCreated } = require("../../../../lib/quickbooks/handlers/handle-sales-receipt-created")
                        await handleSalesReceiptCreated(
                            { order_id: row.order_id, fulfillment_id: row.reference_id, invoice_id: row.reference_id },
                            orderModule, customerModule, req.scope, logger
                        )
                        break
                    }
                    case "payment": {
                        const { handlePosPaymentCreated } = require("../../../../lib/quickbooks/handlers/handle-pos-payment-created")
                        await handlePosPaymentCreated({
                            event: { name: "pos.payment.created", data: { id: row.reference_id ?? row.order_id } },
                            container: req.scope as any,
                            pluginOptions: {}
                        })
                        break
                    }
                    default:
                        logger.warn(`${LOG_PREFIX} No retry handler for step=${row.step}`)
                }
            } catch (handlerErr: any) {
                logger.error(`${LOG_PREFIX} Background retry failed: ${handlerErr.message}`)
            }
        })()

        res.json({ success: true, message: `Retrying ${row.step} — re-submitted to bridge` })
    } catch (err: any) {
        logger.error(`${LOG_PREFIX} Error: ${err.message}`)
        res.status(500).json({ error: "Failed to retry" })
    } finally {
        await client.end()
    }
}

/**
 * DELETE /admin/quickbooks/pipeline
 *
 * Flushes stale operations from both sources:
 *   1. Bridge in-memory queue (all pending/processing ops → failed)
 *   2. Medusa qb_order_pipeline table (all rows deleted)
 *
 * Query params:
 *   bridge=true   — flush the bridge queue (default: true)
 *   medusa=true   — clear the Medusa pipeline table (default: true)
 *   reason        — optional label for the audit log
 */
export async function DELETE(
    req: MedusaRequest,
    res: MedusaResponse
): Promise<void> {
    const flushBridge = req.query.bridge !== "false"
    const flushMedusa = req.query.medusa !== "false"
    const reason = (req.query.reason as string | undefined)
        || "Admin pipeline flush via Medusa UI"

    const result: Record<string, any> = {}

    // 1. Flush bridge queue
    if (flushBridge) {
        try {
            const bridgeRes = await bridgeFetch("POST", "/api/sync/queue/flush", { reason })
            result.bridge = { flushed: bridgeRes.count ?? 0, message: bridgeRes.message }
        } catch (err: any) {
            result.bridge = { error: err.message }
        }
    }

    // 2. Clear Medusa pipeline table
    if (flushMedusa) {
        const client = new Client({ connectionString: process.env.DATABASE_URL })
        try {
            await client.connect()
            const { rowCount } = await client.query("DELETE FROM qb_order_pipeline")
            result.medusa = { deleted: rowCount }
        } catch (err: any) {
            result.medusa = { error: err.message }
        } finally {
            await client.end()
        }
    }

    res.json({ success: true, ...result })
}

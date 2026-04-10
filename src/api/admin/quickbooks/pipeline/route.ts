import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { Client } from "pg"
import { bridgeFetch, pollOperationResult } from "../../../../lib/quickbooks/client/core"
import { ContainerRegistrationKeys, Modules } from "@medusajs/utils"
import { writePipelineRow } from "../../../../lib/quickbooks/qb-pipeline"

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
        const sortBy = req.query.sort_by === "updated_at" ? "updated_at" : "created_at"

        // Auto-timeout: submitted rows older than 10 min with no bridge_op_id → failed
        const { rows: timeout1 } = await client.query(`
            UPDATE qb_order_pipeline
            SET status       = 'failed',
                failed_at    = NOW(),
                confirmed_at = NULL,
                updated_at   = NOW(),
                error        = 'Submission timed out — no bridge_op_id recorded'
            WHERE status = 'submitted'
              AND bridge_op_id IS NULL
              AND submitted_at < NOW() - INTERVAL '10 minutes'
            RETURNING step, qb_txn_id
        `)

        // Auto-timeout: submitted rows with bridge_op_id older than 15 min (QBWC not responding) → failed
        const { rows: timeout2 } = await client.query(`
            UPDATE qb_order_pipeline
            SET status       = 'failed',
                failed_at    = NOW(),
                confirmed_at = NULL,
                updated_at   = NOW(),
                error        = 'QBWC did not respond within 15 minutes — QuickBooks Desktop may be offline or QBWC disconnected'
            WHERE status = 'submitted'
              AND bridge_op_id IS NOT NULL
              AND submitted_at < NOW() - INTERVAL '15 minutes'
            RETURNING step, qb_txn_id
        `)

        // Auto-timeout: pending rows older than 30 min (handler never re-submitted) → failed
        // Uses updated_at so reactivated rows (confirmed→pending) don't immediately time out
        const { rows: timeout3 } = await client.query(`
            UPDATE qb_order_pipeline
            SET status       = 'failed',
                failed_at    = NOW(),
                confirmed_at = NULL,
                updated_at   = NOW(),
                error        = 'Operation stuck in pending — handler did not re-submit within 30 minutes'
            WHERE status = 'pending'
              AND COALESCE(updated_at, created_at) < NOW() - INTERVAL '30 minutes'
            RETURNING step, qb_txn_id
        `)

        // Invalidate cached EditSequence for all timed-out rows
        const { invalidateEditSequenceCache } = require("../../../../lib/quickbooks/qb-pipeline")
        for (const r of [...timeout1, ...timeout2, ...timeout3]) {
            if (r.qb_txn_id) {
                await invalidateEditSequenceCache(r.step, r.qb_txn_id).catch(() => {})
            }
        }

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
                p.seq,
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
                p.medusa_ref_number,
                p.error,
                p.created_at,
                p.updated_at,
                p.submitted_at,
                p.confirmed_at,
                p.failed_at,
                -- Order display_id: direct for order rows, via pos_credit_memo for credit_memo rows
                COALESCE(ord.display_id, cm_ord.display_id) AS order_display_id,
                -- Include parent step info for context
                dep.step AS depends_on_step,
                dep.status AS depends_on_status,
                dep.medusa_ref_number AS depends_on_medusa_ref,
                -- For apply_payment: also join the payment row for dual-dependency display
                pay_dep.medusa_ref_number AS payment_dep_ref,
                pay_dep.status AS payment_dep_status
            FROM qb_order_pipeline p
            LEFT JOIN "order" ord ON ord.id = p.order_id
            LEFT JOIN pos_credit_memo cm ON p.reference_type = 'credit_memo' AND cm.id = p.reference_id
            LEFT JOIN "order" cm_ord ON cm_ord.id = cm.order_id
            LEFT JOIN qb_order_pipeline dep ON dep.id = p.depends_on
            LEFT JOIN qb_order_pipeline pay_dep
                ON p.step = 'apply_payment'
                AND pay_dep.reference_id = p.reference_id
                AND pay_dep.step = 'payment'
            ${where}
            ORDER BY ${sortBy === "updated_at" ? "COALESCE(p.updated_at, p.created_at)" : "p.created_at"} DESC
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

        // 1. Atomically claim the row — only 'failed' and 'waiting' are retryable.
        //    'pending' is excluded because it means a handler is already in-flight;
        //    retrying it would send a second request to QB and create duplicates.
        //    Stuck-pending rows will auto-timeout to 'failed' via the GET auto-timeout logic.
        const { rows } = await client.query(
            `UPDATE qb_order_pipeline
             SET status       = 'pending',
                 error        = NULL,
                 failed_at    = NULL,
                 confirmed_at = NULL,
                 submitted_at = NULL,
                 bridge_op_id = NULL,
                 qb_txn_id    = NULL,
                 qb_ref_number = NULL,
                 retry_count  = retry_count + 1
             WHERE id = $1 AND status IN ('failed', 'waiting')
             RETURNING id, step, order_id, reference_id, reference_type, retry_count, bridge_op_id`,
            [rowId]
        )
        if (!rows.length) {
            res.status(404).json({ error: "Row not found or not retryable (must be 'failed' or 'waiting'; 'pending' rows are actively processing — wait for timeout)" })
            return
        }
        const row = rows[0]

        // 2a. If we already have a bridge_op_id, just re-poll — do NOT resubmit to avoid duplicates
        if (row.bridge_op_id) {
            await client.end()
            logger.info(`${LOG_PREFIX} Found existing bridge_op_id=${row.bridge_op_id} — polling instead of resubmitting`)

            ;(async () => {
                try {
                    const pollResult = await pollOperationResult(row.bridge_op_id, (m: string) => logger.info(m))
                    if (pollResult?.txnId) {
                        await writePipelineRow({
                            orderId: row.order_id,
                            step: row.step,
                            status: "confirmed",
                            bridgeOpId: row.bridge_op_id,
                            qbTxnId: pollResult.txnId,
                            qbRefNumber: pollResult.refNumber ?? null,
                        })
                        logger.info(`${LOG_PREFIX} ✅ Re-poll confirmed TxnID=${pollResult.txnId}`)
                    } else {
                        logger.warn(`${LOG_PREFIX} ⚠️ Re-poll did not return txnId — bridge op may still be pending`)
                    }
                } catch (pollErr: any) {
                    logger.error(`${LOG_PREFIX} Re-poll failed: ${pollErr.message}`)
                }
            })()

            res.json({ message: "Re-polling existing bridge operation", bridge_op_id: row.bridge_op_id })
            return
        }

        // 3. Reset qb_sync_status on the entity so guards allow re-sync
        if (row.order_id) {
            try {
                const orderModule = req.scope.resolve(Modules.ORDER)
                const order = await orderModule.retrieveOrder(row.order_id)
                const meta = (order as any).metadata || {}
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

        // 3b. For payment/apply_payment steps: also reset the customer_payment entity's qb_sync_status
        if ((row.step === "payment" || row.step === "apply_payment") && row.reference_id) {
            try {
                const financeService = req.scope.resolve("finance")
                const payment = await financeService.retrieveCustomerPayment(row.reference_id)
                const pmeta = (payment as any).metadata || {}
                if (pmeta.qb_sync_status && pmeta.qb_sync_status !== "error") {
                    await financeService.updateCustomerPayments({
                        id: row.reference_id,
                        metadata: { ...pmeta, qb_sync_status: "error" }
                    })
                    logger.info(`${LOG_PREFIX} Reset payment qb_sync_status for ${row.reference_id}`)
                }
            } catch (pmErr: any) {
                logger.warn(`${LOG_PREFIX} Could not reset payment qb_sync_status: ${pmErr.message}`)
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
                    case "apply_payment": {
                        const { handlePosPaymentApplied } = require("../../../../lib/quickbooks/handlers/handle-pos-payment-applied")
                        // Fetch the application to get invoice_id and amount_applied
                        const applyClient = new Client({ connectionString: process.env.DATABASE_URL })
                        await applyClient.connect()
                        const { rows: appRows } = await applyClient.query(
                            `SELECT payment_id, invoice_id, order_id, amount_applied FROM customer_payment_application WHERE payment_id = $1 AND voided_at IS NULL LIMIT 1`,
                            [row.reference_id]
                        )
                        await applyClient.end()
                        const appRow = appRows[0]
                        await handlePosPaymentApplied({
                            event: {
                                name: "pos.payment.applied",
                                data: {
                                    payment_id: row.reference_id,
                                    invoice_id: appRow?.invoice_id ?? null,
                                    order_id: appRow?.order_id ?? row.order_id,
                                    amount_applied: appRow?.amount_applied ?? 0,
                                }
                            },
                            container: req.scope as any,
                        })
                        break
                    }
                    case "write_check": {
                        // write_check retries require user to re-select the bank account.
                        // Reset CustomerPayment.qb to null so it reappears in /accounting as "Pending QB".
                        if (row.reference_id) {
                            try {
                                const retryPool = require("../../../../api/utils/db-pool").getDbPool()
                                await retryPool.query(
                                    `UPDATE customer_payment SET qb = NULL WHERE id = $1`,
                                    [row.reference_id]
                                )
                                await retryPool.query(
                                    `UPDATE qb_order_pipeline SET status = 'failed', error = $2, failed_at = NOW(), confirmed_at = NULL, updated_at = NOW() WHERE id = $1`,
                                    [row.id, "Retry: re-process from Accounting page — bank account selection required"]
                                )
                                logger.info(`${LOG_PREFIX} write_check reset → CustomerPayment ${row.reference_id} qb=null, ready for re-process from Accounting`)
                            } catch (wcRetryErr: any) {
                                logger.warn(`${LOG_PREFIX} Could not reset write_check: ${wcRetryErr.message}`)
                            }
                        }
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

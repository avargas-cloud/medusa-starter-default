import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/utils"
import { bridgeFetch } from "../lib/quickbooks/client/core"
import { getDbPool } from "../api/utils/db-pool"
import { confirmPipelineRow, failPipelineRow, cacheEditSequence } from "../lib/quickbooks/qb-pipeline"
import { buildEstimatePatch } from "../lib/quickbooks/qb-metadata-types"

const LOG_PREFIX = "[QB-CONSOLIDATOR]"

/**
 * Runs every 2 minutes.
 * - Polls bridge for submitted pipeline rows that have a bridge_op_id
 * - Marks them confirmed or failed based on bridge response
 * - Saves EditSequence from confirmed responses to the cache
 */
export default async function qbPipelineConsolidator(
    container: MedusaContainer
): Promise<void> {
    const logger = container.resolve(ContainerRegistrationKeys.LOGGER)

    if (process.env.QB_ORDER_FLOW_ENABLED !== "true") return

    const pool = getDbPool()

    // Fetch all submitted rows that have a bridge_op_id (up to 50 at a time)
    let submittedRows: Array<{
        id: string
        order_id: string | null
        reference_id: string | null
        step: string
        bridge_op_id: string
        retry_count: number
    }>

    try {
        const { rows } = await pool.query(`
            SELECT id, order_id, reference_id, step, bridge_op_id, retry_count
            FROM qb_order_pipeline
            WHERE status = 'submitted'
              AND bridge_op_id IS NOT NULL
            ORDER BY created_at ASC
            LIMIT 50
        `)
        submittedRows = rows
    } catch (err: any) {
        logger.error(`${LOG_PREFIX} Failed to query submitted rows: ${err.message}`)
        return
    }

    if (submittedRows.length === 0) return

    logger.info(`${LOG_PREFIX} Polling ${submittedRows.length} submitted operations...`)

    for (const row of submittedRows) {
        try {
            const statusRes = await bridgeFetch("GET", `/api/sync/status/${row.bridge_op_id}`)
            const op = statusRes?.operation

            if (!op) {
                logger.warn(`${LOG_PREFIX} No operation data for ${row.bridge_op_id} (row ${row.id})`)
                continue
            }

            if (op.status === "completed") {
                const msgs = op.result?.QBXML?.QBXMLMsgsRs || op.result?.QBXMLMsgsRs
                const txnId     =
                    op.txnId     ||
                    op.result?.TxnID     ||
                    op.listId            ||
                    op.result?.ListID    ||
                    msgs?.ReceivePaymentAddRs?.ReceivePaymentRet?.TxnID ||
                    msgs?.ReceivePaymentModRs?.ReceivePaymentRet?.TxnID ||
                    msgs?.CreditMemoAddRs?.CreditMemoRet?.TxnID         ||
                    null
                const refNumber =
                    op.refNumber ||
                    op.result?.RefNumber ||
                    msgs?.ReceivePaymentAddRs?.ReceivePaymentRet?.RefNumber ||
                    msgs?.ReceivePaymentModRs?.ReceivePaymentRet?.RefNumber ||
                    msgs?.CreditMemoAddRs?.CreditMemoRet?.RefNumber         ||
                    null

                await confirmPipelineRow(row.id, txnId, refNumber, op.result ?? null)

                // EditSequence: prefer the top-level field (set by bridge since fix),
                // fall back to digging into the raw result for older ops
                const editSeq: string | null =
                    op.editSequence ||
                    op.result?.EditSequence ||
                    op.result?.QBXML?.QBXMLMsgsRs?.EstimateAddRs?.EstimateRet?.EditSequence ||
                    op.result?.QBXML?.QBXMLMsgsRs?.SalesOrderAddRs?.SalesOrderRet?.EditSequence ||
                    op.result?.QBXML?.QBXMLMsgsRs?.InvoiceAddRs?.InvoiceRet?.EditSequence ||
                    msgs?.CreditMemoAddRs?.CreditMemoRet?.EditSequence ||
                    null

                // Cache EditSequence so update/mod ops can skip the GET round-trip
                if (editSeq && txnId) {
                    await cacheEditSequence(row.step, txnId, editSeq)
                }

                // Write TxnID + EditSequence back to order metadata so POS reflects confirmed
                // sync status and future Mod ops have EditSequence ready without a GET
                // For payment steps: write qb_txn_id to customer_payment.metadata so that
                // handlePosPaymentApplied can find it without waiting 400s for a value that
                // was never set (the payment handler only writes txnId when the bridge returns
                // it synchronously; async confirmations come through this consolidator path).
                // Credit memo step: write TxnID + EditSequence to pos_credit_memo
                // so future void operations can reference the QB record.
                if (txnId && row.step === "credit_memo" && row.reference_id) {
                    try {
                        await pool.query(
                            `UPDATE pos_credit_memo
                             SET qb_txn_id = $2, qb_edit_sequence = $3
                             WHERE id = $1`,
                            [row.reference_id, txnId, editSeq ?? null]
                        )
                        logger.info(`${LOG_PREFIX} ✅ Wrote qb_txn_id=${txnId} + editSeq to pos_credit_memo ${row.reference_id}`)
                    } catch (cmErr: any) {
                        logger.warn(`${LOG_PREFIX} ⚠️ Could not update pos_credit_memo: ${cmErr.message}`)
                    }

                    // Also propagate qb_txn_id to the customer_payment (store credit) derived
                    // from this credit memo — so it can be used as a QB credit when applying
                    // to a future invoice via POST /api/payments/{qb_txn_id}/apply
                    try {
                        const { rows: cmRows } = await pool.query(
                            `SELECT credit_memo_number FROM pos_credit_memo WHERE id = $1`,
                            [row.reference_id]
                        )
                        const cmNumber = cmRows[0]?.credit_memo_number // e.g. "CM-20066"
                        if (cmNumber) {
                            const { rowCount } = await pool.query(
                                `UPDATE customer_payment
                                 SET metadata = COALESCE(metadata, '{}') || $2::jsonb
                                 WHERE reference = $1
                                   AND (metadata->>'qb_txn_id') IS NULL`,
                                [cmNumber, JSON.stringify({ qb_txn_id: txnId, qb_sync_status: "synced" })]
                            )
                            if (rowCount && rowCount > 0) {
                                logger.info(`${LOG_PREFIX} ✅ Wrote qb_txn_id=${txnId} to customer_payment linked to ${cmNumber}`)
                            }
                        }
                    } catch (cpErr: any) {
                        logger.warn(`${LOG_PREFIX} ⚠️ Could not propagate qb_txn_id to customer_payment: ${cpErr.message}`)
                    }
                }

                if (txnId && row.step === "payment" && row.reference_id) {
                    try {
                        const { rows: cpRows } = await pool.query(
                            `SELECT metadata FROM customer_payment WHERE id = $1`,
                            [row.reference_id]
                        )
                        const cpMeta = cpRows[0]?.metadata || {}
                        if (!cpMeta.qb_txn_id) {
                            await pool.query(
                                `UPDATE customer_payment
                                 SET metadata = COALESCE(metadata, '{}') || $2::jsonb
                                 WHERE id = $1`,
                                [row.reference_id, JSON.stringify({ qb_txn_id: txnId, qb_sync_status: "synced" })]
                            )
                            logger.info(`${LOG_PREFIX} ✅ Wrote qb_txn_id=${txnId} to customer_payment ${row.reference_id}`)
                        }
                    } catch (cpErr: any) {
                        logger.warn(`${LOG_PREFIX} ⚠️ Could not update customer_payment metadata: ${cpErr.message}`)
                    }
                }

                if (txnId && row.order_id) {
                    try {
                        const orderModule = container.resolve(Modules.ORDER)
                        const { rows: metaRows } = await pool.query(
                            `SELECT metadata FROM "order" WHERE id = $1`,
                            [row.order_id]
                        )
                        const existingMeta = metaRows[0]?.metadata || {}

                        let patch: Record<string, any>
                        if (row.step === "estimate") {
                            patch = buildEstimatePatch(existingMeta, {
                                txnId,
                                refNumber,
                                operationId: null,
                                editSequence: editSeq,
                                syncStatus: "synced",
                            })
                        } else {
                            // For other steps, only update if we have an editSequence to save
                            // (full patches for SO/Invoice/Payment are written by their own handlers)
                            if (!editSeq) {
                                logger.info(`${LOG_PREFIX} ℹ️ No metadata update needed for step=${row.step} (no editSequence)`)
                                continue
                            }
                            // Merge editSequence into existing qb_<step> sub-object
                            const stepKey = row.step === "sales_order" ? "qb_sales_order"
                                : row.step === "invoice" ? "qb_invoices"
                                : null
                            if (stepKey && stepKey !== "qb_invoices") {
                                const existing = existingMeta[stepKey] || {}
                                patch = {
                                    ...existingMeta,
                                    [stepKey]: { ...existing, edit_sequence: editSeq },
                                }
                            } else {
                                patch = existingMeta // nothing to merge safely
                            }
                        }

                        await orderModule.updateOrders(row.order_id, { metadata: patch })
                        logger.info(`${LOG_PREFIX} ✅ Updated order ${row.order_id} metadata — step=${row.step}, TxnID=${txnId}, editSequence=${editSeq ? "✓" : "—"}`)
                    } catch (metaErr: any) {
                        logger.warn(`${LOG_PREFIX} ⚠️ Could not update order metadata for ${row.order_id}: ${metaErr.message}`)
                    }
                }

                logger.info(`${LOG_PREFIX} ✅ Confirmed row ${row.id} (${row.step}) — TxnID=${txnId}, Ref=${refNumber}`)

            } else if (op.status === "failed") {
                const errMsg = op.error || "QB operation failed (no details)"
                await failPipelineRow(row.id, errMsg)
                logger.warn(`${LOG_PREFIX} ❌ Failed row ${row.id} (${row.step}): ${errMsg}`)

            } else {
                // Still pending/processing on bridge side — nothing to do yet
                logger.info(`${LOG_PREFIX} ⏳ Row ${row.id} (${row.step}) bridge status: ${op.status}`)
            }

        } catch (pollErr: any) {
            logger.warn(`${LOG_PREFIX} ⚠️ Error polling row ${row.id} op ${row.bridge_op_id}: ${pollErr.message}`)
        }
    }
}

export const config = {
    name: "qb-pipeline-consolidator",
    schedule: "*/1 * * * *", // TODO: change back to */2 after testing
}

import { ContainerRegistrationKeys } from "@medusajs/utils"
import { getDbPool } from "../../../api/utils/db-pool"
import { processSalesReceiptInQb, buildQbItems, buildShippingQbItem, buildQbOrderDiscountLines } from "../order-flow-core"
import { buildInvoicePatch } from "../qb-metadata-types"
import { getSoTxnId, getEstimateTxnId } from "../qb-metadata-types"
import { LOG_PREFIX, getQbConfig, getFloat } from "./utils"
import { writePipelineRow, cacheEditSequence, skipSalesOrderPipelineRow } from "../qb-pipeline"
import { handleFulfillmentCreated } from "./handle-fulfillment-created"
import { parseSalesRepInitials } from "../parse-sales-rep"

export async function handleSalesReceiptCreated(
    data: any,
    orderModule: any,
    customerModule: any,
    _container: any,
    logger: any
) {
    const orderId = data.order_id || data.id
    logger.info(`${LOG_PREFIX} ── pos.sales_receipt.created → orderId=${orderId} ──`)
    logger.info(`${LOG_PREFIX} Sales Receipt event data: ${JSON.stringify(data)}`)

    let order: any
    try {
        const query = _container.resolve(ContainerRegistrationKeys.QUERY)
        const { data: [fetchedOrder] } = await query.graph({
            entity: "order",
            fields: [
                "id", "display_id", "status", "metadata", "tax_total", "total",
                "sales_channel_id",
                "customer_id",
                "subtotal",
                "discount_total",
                "promotions.*",
                "promotions.application_method.*",
                "items.*",
                "items.item.unit_price",
                "items.variant.*",
                "items.variant.metadata",
                "customer.*",
                "customer.metadata",
                "shipping_methods.*"
            ],
            filters: { id: orderId }
        })

        if (!fetchedOrder) throw new Error(`Query returned no order for id ${orderId}`)
        order = fetchedOrder
        logger.info(`${LOG_PREFIX} Order fetched for Sales Receipt: #${order.display_id}, customer_id=${order.customer_id}`)
    } catch (err: any) {
        logger.error(`${LOG_PREFIX} ❌ Failed to fetch order ${orderId}: ${err.message}`)
        return
    }

    let qbCustomerId: string | undefined = order.metadata?.qb_list_id

    if (!qbCustomerId && order.customer_id) {
        logger.info(`${LOG_PREFIX} qb_list_id not in order.metadata — fetching customer ${order.customer_id}...`)
        try {
            const customer = await customerModule.retrieveCustomer(order.customer_id)
            qbCustomerId = customer.metadata?.qb_list_id
        } catch (custErr: any) {
            logger.warn(`${LOG_PREFIX} ⚠️ Could not fetch customer: ${custErr.message}`)
        }
    }

    if (!qbCustomerId) {
        logger.warn(`${LOG_PREFIX} ❌ Missing required qb_list_id for Sales Receipt creation.`)
        return
    }

    // ── Sales Receipt Qualification Guard ────────────────────────────────────
    // A Sales Receipt is only valid if NO QB Sales Order or Estimate already
    // exists for this order. If the 1-hour POS cron ran first and created a
    // Sales Order (or Estimate), we must fall back to a regular Invoice so we
    // don't create a duplicate/conflicting document in QB Desktop.
    const existingSoTxnId = getSoTxnId(order.metadata)
    const existingEstimateTxnId = getEstimateTxnId(order.metadata)

    const hasRealSo = existingSoTxnId && existingSoTxnId !== "SKIPPED_SALES_RECEIPT"
    const hasRealEstimate = !!existingEstimateTxnId

    if (hasRealSo || hasRealEstimate) {
        logger.warn(
            `${LOG_PREFIX} ⚠️ Order already has a QB document ` +
            `(SO=${existingSoTxnId ?? "none"}, Estimate=${existingEstimateTxnId ?? "none"}). ` +
            `Cannot create Sales Receipt — falling back to Invoice.`
        )
        await handleFulfillmentCreated(data, orderModule, customerModule, _container, logger)
        return
    }
    // ─────────────────────────────────────────────────────────────────────────

    let fulfillmentItems: any[] = data.items && Array.isArray(data.items) ? data.items : []

    if (data.fulfillment_id && fulfillmentItems.length === 0) {
        try {
            const query = _container.resolve(ContainerRegistrationKeys.QUERY)
            const { data: [fulfillment] } = await query.graph({
                entity: "fulfillment",
                fields: ["items.*"],
                filters: { id: data.fulfillment_id }
            })
            if (fulfillment && fulfillment.items) {
                fulfillmentItems = fulfillment.items
            }
        } catch (e: any) {
            logger.warn(`${LOG_PREFIX} Failed to fetch fulfillment items: ${e.message}`)
        }
    }

    const pool = getDbPool()
    let memo: string | undefined
    let invoiceShippingAmount: number | undefined;
    let srRefNumber: string | undefined;

    try {
        let sql = `SELECT invoice_number, metadata->>'qb_ref_number' AS qb_ref_number, shipping FROM pos_invoice WHERE fulfillment_id = $1 LIMIT 1`;
        let params: any[] = [data.fulfillment_id];

        if (data.invoice_id) {
            sql = `SELECT invoice_number, metadata->>'qb_ref_number' AS qb_ref_number, shipping FROM pos_invoice WHERE id = $1 LIMIT 1`;
            params = [data.invoice_id];
        }

        const invRes = await pool.query(sql, params)
        const row = invRes.rows[0];
        if (row) {
            const seq = row.qb_ref_number || row.invoice_number
            if (seq) {
                srRefNumber = String(seq)
            }
            if (row.invoice_number) {
                memo = `POS Invoice ${row.invoice_number}`
            }
            if (row.shipping !== undefined && row.shipping !== null) {
                // pos_invoice.shipping is stored in cents — convert to dollars for QB
                invoiceShippingAmount = Number(row.shipping) / 100
            }
        }
    } catch (e) {
    }

    let prebuiltItems: any[] | undefined
    let salesTaxCode: string | undefined
    const qbConfig = await getQbConfig()
    const orderDiscountTotal = getFloat(order.discount_total || 0)

    const activeItems = (order.items || [])
        .filter((item: any) => (item.quantity ?? 0) > 0)
        .map((item: any) => ({
            ...item,
            unit_price: getFloat(item.unit_price),
            subtotal: item.subtotal !== undefined ? getFloat(item.subtotal) : undefined,
        }))

    prebuiltItems = buildQbItems(activeItems, order.metadata)

    if (orderDiscountTotal > 0) {
        const orderSubtotal = getFloat(order.subtotal)
        const discountPercent = orderSubtotal > 0 ? (orderDiscountTotal / orderSubtotal) * 100 : null
        buildQbOrderDiscountLines(orderDiscountTotal, discountPercent).forEach(l => prebuiltItems!.push(l))
    }

    let shippingMethodsFormatted = ((order as any).shipping_methods || []).map((sm: any) => ({
        ...sm,
        amount: getFloat(sm.amount)
    }))

    if (invoiceShippingAmount !== undefined) {
        if (shippingMethodsFormatted.length > 0) {
            shippingMethodsFormatted[0].amount = invoiceShippingAmount
            shippingMethodsFormatted = [shippingMethodsFormatted[0]]
        } else if (invoiceShippingAmount > 0) {
            shippingMethodsFormatted = [{
                name: "Shipping",
                amount: invoiceShippingAmount
            }]
        } else {
            shippingMethodsFormatted = []
        }
    }

    const shippingItem = buildShippingQbItem(
        shippingMethodsFormatted,
        qbConfig.shippingItemId
    )
    if (shippingItem) {
        prebuiltItems.push(shippingItem)
    }

    const hasTax = getFloat(order.tax_total) > 0
    salesTaxCode = hasTax ? qbConfig.defaultSalesTaxCode : undefined

    try {
        await orderModule.updateOrders(orderId, {
            metadata: { ...(order.metadata || {}), qb_sync_status: "creating" }
        })
    } catch (mErr) {
        logger.warn(`${LOG_PREFIX} Could not set creating status: ${mErr}`)
    }

    // Skip the Sales Order pipeline row — a Sales Receipt supersedes the need for a separate SO.
    try {
        await skipSalesOrderPipelineRow(orderId)
    } catch (skipErr: any) {
        logger.warn(`${LOG_PREFIX} ⚠️ Could not skip SO pipeline row: ${skipErr.message}`)
    }

    // Pre-flight: transition waiting → pending so the UI shows progress
    try {
        await writePipelineRow({
            orderId,
            referenceId:   data.invoice_id || null,
            referenceType: data.invoice_id ? "pos_invoice" : null,
            step:   "sales_receipt",
            status: "pending",
        })
    } catch (pErr: any) {
        logger.warn(`${LOG_PREFIX} ⚠️ Could not write pre-flight pipeline row: ${pErr.message}`)
    }

    const result = await processSalesReceiptInQb({
        orderId,
        orderDisplayId: order.display_id,
        qbCustomerId,
        paymentMethod: data.payment_method,
        prebuiltItems,
        salesTaxCode,
        salesRep: parseSalesRepInitials(order.metadata?.sales_rep),
        refNumber: srRefNumber,
        memo,
        onSubmitted: async (operationId) => {
            await writePipelineRow({
                orderId,
                referenceId: data.invoice_id || null,
                referenceType: data.invoice_id ? "pos_invoice" : null,
                step: "sales_receipt",
                status: "submitted",
                bridgeOpId: operationId,
            })
        },
    })

    if (result.skipped) {
        logger.info(`${LOG_PREFIX} ⏭️ Sales Receipt skipped (QB disabled)`)
        return
    }
    if (result.error) {
        logger.error(`${LOG_PREFIX} ❌ processSalesReceiptInQb error: ${result.error}`)
        try {
            await orderModule.updateOrders(orderId, {
                metadata: { ...(order.metadata || {}), qb_sync_status: "error" }
            })
        } catch (mErr) {}
        try {
            await writePipelineRow({
                orderId,
                referenceId:   data.invoice_id || null,
                referenceType: data.invoice_id ? "pos_invoice" : null,
                step:   "sales_receipt",
                status: "failed",
                error:  result.error,
            })
        } catch (pErr: any) {
            logger.warn(`${LOG_PREFIX} ⚠️ Could not write pipeline row: ${pErr.message}`)
        }
        return
    }

    if (result.txnId || result.operationId) {
        // Record in pipeline
        try {
            await writePipelineRow({
                orderId,
                referenceId:   data.invoice_id || null,
                referenceType: data.invoice_id ? "pos_invoice" : null,
                step:        "sales_receipt",
                status:      result.operationId && !result.txnId ? "submitted" : "confirmed",
                bridgeOpId:  result.operationId || null,
                qbTxnId:     result.txnId || null,
                qbRefNumber: result.refNumber || null,
            })
        } catch (pErr: any) {
            logger.warn(`${LOG_PREFIX} ⚠️ Could not write pipeline row: ${pErr.message}`)
        }

        if (result.editSequence && result.txnId) {
            try {
                await cacheEditSequence("sales_receipt", result.txnId, result.editSequence)
                logger.info(`${LOG_PREFIX} ✅ Cached EditSequence for Sales Receipt TxnID=${result.txnId}`)
            } catch (cacheErr: any) {
                logger.warn(`${LOG_PREFIX} ⚠️ Could not cache EditSequence: ${cacheErr.message}`)
            }
        }

        try {
            const fulfillmentId: string | null = (data.fulfillment_id as string | undefined) ?? null
            const invoiceId: string | null = (data.invoice_id as string | undefined) ?? null

            // Critical Step: Pre-emptively write SKIPPED_SALES_RECEIPT so the cron doesn't create an SO
            const existingOrderMeta = order.metadata || {}
            const basePatch = buildInvoicePatch(existingOrderMeta, {
                txnId:         result.txnId || null,
                refNumber:     result.refNumber || null,
                operationId:   result.operationId || null,
                fulfillmentId,
                invoiceId,
                syncStatus:    "child_synced",
            })
            
            await orderModule.updateOrders(orderId, { 
                metadata: {
                    ...basePatch,
                    qb_so_txn_id: "SKIPPED_SALES_RECEIPT"
                } 
            })

            // Update local pos_invoice and fulfillment with native QB IDs (adding SR- prefix)
            if (invoiceId) {
                let invoiceService: any
                try {
                    invoiceService = _container.resolve("invoices")
                } catch (e) { }
                
                if (invoiceService) {
                    try {
                        const inv = await invoiceService.retrievePosInvoice(invoiceId)
                        await invoiceService.updatePosInvoices({
                            id: invoiceId,
                            metadata: {
                                ...(inv.metadata || {}),
                                qb_txn_id: result.txnId || null,
                                qb_ref_number: result.refNumber || null,
                                qb_operation_id: result.operationId || null
                            }
                        })
                    } catch (metaErr: any) { }
                }

                let financeService: any
                try {
                    financeService = _container.resolve("finance")
                } catch (e) { }

                if (financeService) {
                    try {
                        // payment_id may be null for SR (invoice route intentionally omits it).
                        // Fall back to looking up by any of: is_sales_receipt_payment flag (manual
                        // SR flow), qb_source='sales_receipt' (terminal SR flow), or qb_sync_status
                        // ='pending_sr' (tagged by invoice route on terminal-linked SR).
                        // Never use a broad order_id fallback — it would incorrectly tag pre-existing
                        // deposit payments (e.g. from BAMS payment link) as the Sales Receipt payment.
                        let srPayment: any = null
                        if (data.payment_id) {
                            srPayment = await financeService.retrieveCustomerPayment(data.payment_id)
                        } else {
                            const payments = await financeService.listCustomerPayments({
                                metadata: { order_id: orderId },
                            }).catch(() => [])
                            srPayment = (payments as any[]).find((p: any) =>
                                p.metadata?.is_sales_receipt_payment === true
                             || p.metadata?.qb_source === 'sales_receipt'
                             || p.metadata?.qb_sync_status === 'pending_sr'
                            ) ?? null
                        }

                        if (srPayment) {
                            // Mark as Sales Receipt source — prevents ReceivePayment duplicate in QB
                            // and blocks apply/unapply operations (SR payments are embedded, not standalone)
                            await financeService.updateCustomerPayments({
                                id: srPayment.id,
                                metadata: {
                                    ...(srPayment.metadata || {}),
                                    qb_txn_id: result.txnId || null,
                                    qb_ref_number: result.refNumber || null,
                                    qb_operation_id: result.operationId || null,
                                    qb_sync_status: 'synced',
                                    qb_source: 'sales_receipt',
                                },
                                qb: {
                                    status: 'yes',
                                    txn_id: result.txnId || null,
                                    source: 'sales_receipt',
                                    edit_sequence: 'No editable',
                                },
                            })
                            logger.info(`${LOG_PREFIX} ✅ Tagged Payment ${srPayment.id} with SR ${result.refNumber} (source=sales_receipt)`)
                        } else {
                            logger.warn(`${LOG_PREFIX} ⚠️ Could not find SR payment for order ${orderId} to tag`)
                        }
                    } catch (payErr: any) {
                        logger.warn(`${LOG_PREFIX} ⚠️ Failed to tag Sales Receipt payment: ${payErr.message}`)
                    }
                }
            }

            if (fulfillmentId) {
                try {
                    const fulfillmentModule = _container.resolve("fulfillment")
                    const ful = await fulfillmentModule.retrieveFulfillment(fulfillmentId)
                    await fulfillmentModule.updateFulfillment(fulfillmentId, {
                        metadata: {
                            ...(ful.metadata || {}),
                            qb_txn_id: result.txnId || null,
                            qb_ref_number: result.refNumber || null,
                        }
                    })
                } catch (fulErr: any) { }
            }
            logger.info(`${LOG_PREFIX} ✅ Saved Sales Receipt metadata — TxnID=${result.txnId}, Ref=${result.refNumber}`)
        } catch (metaErr: any) {
            logger.error(`${LOG_PREFIX} ⚠️ Failed to save Sales Receipt metadata: ${metaErr.message}`)
        }
    }
}

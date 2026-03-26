import { ContainerRegistrationKeys } from "@medusajs/utils"
import { getDbPool } from "../../../api/utils/db-pool"
import { processSalesReceiptInQb, buildQbItems, buildShippingQbItem, buildQbOrderDiscountLines } from "../order-flow-core"
import { buildInvoicePatch } from "../qb-metadata-types"
import { LOG_PREFIX, getQbConfig, getFloat } from "./utils"

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
    let memo = order.metadata?.pos_notes ? `POS Note: ${order.metadata.pos_notes}` : undefined
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
                memo = memo ? `${memo} | Sales Receipt ${seq}` : `Sales Receipt ${seq}`
            }
            if (row.shipping !== undefined && row.shipping !== null) {
                invoiceShippingAmount = Number(row.shipping)
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

    const result = await processSalesReceiptInQb({
        orderId,
        orderDisplayId: order.display_id,
        qbCustomerId,
        paymentMethod: data.payment_method,
        prebuiltItems,
        salesTaxCode,
        refNumber: srRefNumber,
        memo,
    })

    if (result.skipped) {
        logger.info(`${LOG_PREFIX} ⏭️ Sales Receipt skipped (QB disabled)`)
        return
    }
    if (result.error) {
        logger.error(`${LOG_PREFIX} ❌ processSalesReceiptInQb error: ${result.error}`)
        return
    }

    if (result.txnId || result.operationId) {
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
                                qb_ref_number: result.refNumber || (result.txnId ? `SR-${result.txnId}` : null),
                                qb_operation_id: result.operationId || null
                            }
                        })
                    } catch (metaErr: any) { }
                }

                let financeService: any
                try {
                    financeService = _container.resolve("finance")
                } catch (e) { }

                if (financeService && data.payment_id) {
                    try {
                        const payment = await financeService.retrieveCustomerPayment(data.payment_id)
                        await financeService.updateCustomerPayment(payment.id, {
                            metadata: {
                                ...(payment.metadata || {}),
                                qb_txn_id: result.txnId || null,
                                qb_ref_number: result.refNumber || (result.txnId ? `SR-${result.txnId}` : null),
                                qb_operation_id: result.operationId || null
                            }
                        })
                        logger.info(`${LOG_PREFIX} ✅ Tagged Payment ${payment.id} with SR ${result.refNumber}`)
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
                            qb_ref_number: result.refNumber || (result.txnId ? `SR-${result.txnId}` : null),
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

import { ContainerRegistrationKeys } from "@medusajs/utils"
import { processOrderInQb, buildQbItems, buildShippingQbItem, buildQbOrderDiscountLines } from "../order-flow-core"
import { buildSaleOrderPatch, getEstimateTxnId, getSoTxnId, getSoOperationId } from "../qb-metadata-types"
import { LOG_PREFIX, getQbConfig, isPosOrder, processingOrders } from "./utils"

export async function handleOrderPlaced(
    data: any,
    orderModule: any,
    customerModule: any,
    _container: any,
    logger: any,
    isCron: boolean = false
) {
    const orderId = data.id
    logger.info(`${LOG_PREFIX} ── order.placed → ${orderId} ──`)

    // Read QB config (shipping item ID + sales tax code)
    const qbConfig = await getQbConfig()

    let order: any
    try {
        const query = _container.resolve(ContainerRegistrationKeys.QUERY)
        const { data: [fetchedOrder] } = await query.graph({
            entity: "order",
            fields: [
                "id", "display_id", "status", "metadata", "tax_total",
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

        if (!fetchedOrder) {
            throw new Error(`Query returned no order for id ${orderId}`)
        }
        order = fetchedOrder
        logger.info(`${LOG_PREFIX} Order fetched via Query: #${order.display_id}, items=${order.items?.length ?? 0}, shipping_methods=${order.shipping_methods?.length ?? 0}, sales_channel_id=${order.sales_channel_id ?? "none"}`)

        if (!isCron && isPosOrder(order)) {
            logger.info(`${LOG_PREFIX} ⏭️ POS order (channel: ${order.sales_channel_id}) — Sales Order creation delayed by 1 hour (handled by cron), skipping immediate sync`)
            return
        }

        if (order.items && order.items[0]) {
            logger.info(`${LOG_PREFIX} DEBUG: First item variant: ${JSON.stringify(order.items[0].variant)}`)
        }
    } catch (err: any) {
        logger.error(`${LOG_PREFIX} ❌ Failed to fetch order ${orderId} via Query: ${err.message}`)
        return
    }

    logger.info(`${LOG_PREFIX} Order metadata: ${JSON.stringify(order.metadata || {})}`)

    if (processingOrders.has(orderId)) {
        logger.info(`${LOG_PREFIX} ⏭️ Already processing ${orderId} in this process — skipping duplicate`)
        return
    }
    processingOrders.add(orderId)

    try {
        const existingSoTxnId = getSoTxnId(order.metadata)
        if (existingSoTxnId) {
            logger.info(`${LOG_PREFIX} ⏭️ QB SO already exists (txnId=${existingSoTxnId}) — skipping duplicate`)
            return
        }
        const existingSoOpId = getSoOperationId(order.metadata)
        if (existingSoOpId) {
            logger.info(`${LOG_PREFIX} ⏭️ QB SO already queued (opId=${existingSoOpId}) — skipping duplicate`)
            return
        }

        const estimateTxnId = getEstimateTxnId(order.metadata)
        if (estimateTxnId) {
            logger.info(`${LOG_PREFIX} ✅ Order has qb_estimate_txn_id=${estimateTxnId} — will convert Estimate→SO`)
        } else {
            logger.info(`${LOG_PREFIX} ℹ️ No qb_estimate_txn_id — direct order path (will check customer)`)
        }

        let customer = (order as any).customer ?? null
        if (!customer && order.customer_id) {
            try {
                customer = await customerModule.retrieveCustomer(order.customer_id, {
                    relations: ["addresses"],
                })
                logger.info(`${LOG_PREFIX} Customer fetched separately: ${customer.email} | qb_list_id=${customer.metadata?.qb_list_id ?? "NOT SET"}`)
            } catch (custErr: any) {
                logger.warn(`${LOG_PREFIX} ⚠️ Could not fetch customer ${order.customer_id}: ${custErr.message}`)
            }
        } else if (customer) {
            logger.info(`${LOG_PREFIX} Customer embedded: ${customer.email} | qb_list_id=${customer.metadata?.qb_list_id ?? "NOT SET"}`)
        } else {
            logger.warn(`${LOG_PREFIX} ⚠️ Order ${orderId} has no customer_id`)
        }

        const orderDiscountTotal = Number(order.discount_total || 0)

        const activeItems = (order.items || [])
            .filter((item: any) => (item.quantity ?? 0) > 0)
            .map((item: any) => ({
                ...item,
                unit_price: Number(item.unit_price || 0),
                subtotal: undefined,
            }))

        const qbItems = buildQbItems(activeItems, order.metadata)

        if (orderDiscountTotal > 0) {
            const orderSubtotal = Number(order.subtotal || 0)
            const discountPercent = orderSubtotal > 0 ? (orderDiscountTotal / orderSubtotal) * 100 : null
            buildQbOrderDiscountLines(orderDiscountTotal, discountPercent).forEach(l => qbItems.push(l))
            logger.info(`${LOG_PREFIX} Discount lines added: -$${orderDiscountTotal.toFixed(2)}`)
        }

        const shippingItem = buildShippingQbItem(
            (order as any).shipping_methods || [],
            qbConfig.shippingItemId
        )
        if (shippingItem) {
            qbItems.push(shippingItem)
            logger.info(`${LOG_PREFIX} Shipping line added: $${shippingItem.price?.toFixed(2)} (${shippingItem.desc})`)
        } else {
            logger.info(`${LOG_PREFIX} No shipping line (pickup or $0)`)
        }

        const hasTax = order.tax_total && order.tax_total > 0
        const salesTaxCode = hasTax ? qbConfig.defaultSalesTaxCode : undefined
        logger.info(`${LOG_PREFIX} tax_total=${order.tax_total} → salesTaxCode=${salesTaxCode ?? "Exempt (none passed)"}`)

        const orderWithCustomer = { ...order, customer, items: activeItems }

        // Inject pre-flight metadata so UI shows "CREATING..."
        try {
            await orderModule.updateOrders(orderId, {
                metadata: { ...(order.metadata || {}), qb_sync_status: "creating" }
            })
        } catch (mErr) {
            logger.warn(`${LOG_PREFIX} Could not set creating status: ${mErr}`)
        }

        const result = await processOrderInQb(orderWithCustomer, customerModule, {
            prebuiltItems: qbItems,
            salesTaxCode,
        })

        if (result.skipped) {
            logger.info(`${LOG_PREFIX} ⏭️ Skipped: ${result.skipReason}`)
            return
        }
        if (!result.enabled) {
            logger.info(`${LOG_PREFIX} ⏭️ QB disabled: ${result.skipReason}`)
            return
        }
        if (result.error) {
            logger.error(`${LOG_PREFIX} ❌ processOrderInQb error: ${result.error}`)
            try {
                await orderModule.updateOrders(orderId, {
                    metadata: { ...(order.metadata || {}), qb_sync_status: "error" }
                })
            } catch (mErr) {}
            return
        }

        if (result.soTxnId || result.operationId) {
            try {
                // If we got here, it's definitively "synced"
                const patch = buildSaleOrderPatch(order.metadata || {}, {
                    txnId:       result.soTxnId || null,
                    refNumber:   result.soRefNumber || null,
                    operationId: result.operationId || null,
                    customerId:  result.customerId || null,
                    syncStatus:  "synced",
                })
                await orderModule.updateOrders(orderId, { metadata: patch })
                logger.info(`${LOG_PREFIX} ✅ Saved SO metadata — TxnID=${result.soTxnId}, Ref=${result.soRefNumber}, OpID=${result.operationId}, status=synced`)
            } catch (metaErr: any) {
                logger.error(`${LOG_PREFIX} ⚠️ Failed to save order metadata: ${metaErr.message}`)
            }
        } else {
            logger.warn(`${LOG_PREFIX} ⚠️ No soTxnId or operationId returned — QB document may not have been created`)
            try {
                await orderModule.updateOrders(orderId, {
                    metadata: { ...(order.metadata || {}), qb_sync_status: "error" }
                })
            } catch (mErr) {}
        }

    } finally {
        processingOrders.delete(orderId)
    }
}

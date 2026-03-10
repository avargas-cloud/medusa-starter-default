/**
 * qb-draft-order-subscriber.ts
 *
 * Event-driven subscriber that creates QB Estimates when
 * Draft Orders are created in Medusa Admin.
 *
 * Events handled:
 *   - draft_order.created → Create Estimate in QB
 *
 * When a Draft Order is later confirmed → converted to a real Order,
 * the `order.placed` event fires and qb-order-subscriber detects
 * the estimate via `qb_estimate_txn_id` in metadata, then converts
 * the Estimate into a Sales Order automatically.
 *
 * DISABLED BY DEFAULT: Set QB_ORDER_FLOW_ENABLED=true to activate.
 *
 * Metadata stored on draft order:
 *   qb_estimate_txn_id, qb_estimate_ref, qb_list_id (customer QB ID)
 */

import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import { Modules, ContainerRegistrationKeys } from "@medusajs/utils"
import {
    ensureCustomerInQb,
    buildQbItems,
    processEstimateInQb,
} from "../lib/quickbooks/order-flow-core"

const LOG_PREFIX = "[QB-DRAFT]"
const ENABLED = process.env.QB_ORDER_FLOW_ENABLED === "true"

// ─── Subscriber Handler ─────────────────────────────────────────────────────

async function qbDraftOrderSubscriber({ event, container }: SubscriberArgs<any>) {
    const logger = container.resolve(ContainerRegistrationKeys.LOGGER)

    // ── Guard: feature flag ──────────────────────────────────────────────────
    if (!ENABLED) {
        logger.info(`${LOG_PREFIX} ⏭️ QB_ORDER_FLOW_ENABLED=false — skipping ${event.name}`)
        return
    }

    logger.info(`${LOG_PREFIX} 📥 Received event: ${event.name} | data: ${JSON.stringify(event.data)}`)

    try {
        if (event.name === "draft_order.created") {
            await handleDraftOrderCreated(event.data, container, logger)
        }
    } catch (err: any) {
        // QB failures must NEVER block the Medusa flow
        logger.error(`${LOG_PREFIX} ❌ Unhandled exception in ${event.name}: ${err.message}`)
        logger.error(`${LOG_PREFIX} Stack: ${err.stack}`)
    }
}

// ─── Event Handlers ──────────────────────────────────────────────────────────

async function handleDraftOrderCreated(data: any, container: any, logger: any) {
    const draftOrderId = data.id
    logger.info(`${LOG_PREFIX} ── draft_order.created → ${draftOrderId} ──`)

    const query = container.resolve(ContainerRegistrationKeys.QUERY)
    const customerModule = container.resolve(Modules.CUSTOMER)

    // Fetch draft order with items + customer
    let draftOrder: any
    try {
        const { data: results } = await query.graph({
            entity: "draft_order",
            fields: [
                "id",
                "metadata",
                "customer.*",
                "customer.metadata",
                "customer.addresses.*",
                "items.*",
                "items.variant.*",
                "items.variant.metadata",
            ],
            filters: { id: draftOrderId },
        })
        draftOrder = results?.[0]
    } catch (fetchErr: any) {
        logger.error(`${LOG_PREFIX} ❌ Failed to fetch draft order: ${fetchErr.message}`)
        return
    }

    if (!draftOrder) {
        logger.warn(`${LOG_PREFIX} Draft order ${draftOrderId} not found`)
        return
    }

    logger.info(`${LOG_PREFIX} Draft order metadata: ${JSON.stringify(draftOrder.metadata || {})}`)
    logger.info(`${LOG_PREFIX} Draft order items: ${draftOrder.items?.length ?? 0}`)

    // Ensure customer in QB
    const customer = draftOrder.customer
    if (!customer) {
        logger.warn(`${LOG_PREFIX} Draft order has no customer — skipping`)
        return
    }

    logger.info(`${LOG_PREFIX} Customer: ${customer.email} | qb_list_id=${customer.metadata?.qb_list_id ?? "NOT SET"}`)

    const custResult = await ensureCustomerInQb(customer, customerModule, (msg) => logger.info(msg))
    if (!custResult.success) {
        logger.error(`${LOG_PREFIX} ❌ Customer check failed: ${custResult.error}`)
        return
    }

    logger.info(`${LOG_PREFIX} ✅ Customer in QB: qb_list_id=${custResult.qbCustomerId}`)

    // Build QB items — query.graph returns unit_price in DOLLARS; buildQbItems expects CENTS
    const itemsForQb = (draftOrder.items || []).map((item: any) => ({
        ...item,
        unit_price: Math.round((item.unit_price || 0) * 100), // dollars → cents for buildQbItems
    }))
    const qbItems = buildQbItems(itemsForQb, draftOrder.metadata)
    logger.info(`${LOG_PREFIX} QB-linked items: ${qbItems.length} of ${draftOrder.items?.length ?? 0} total`)

    if (qbItems.length === 0) {
        logger.warn(`${LOG_PREFIX} ⚠️ No QB-linked items in draft order — skipping Estimate`)
        logger.warn(`${LOG_PREFIX} Items need variant.metadata.quickbooks_id to be synced`)
        return
    }

    // Log each item being sent to QB
    qbItems.forEach((item, i) => {
        logger.info(`${LOG_PREFIX} Item[${i}]: productId=${item.productId}, qty=${item.quantity}, price=$${item.price}, uom=${item.unitOfMeasure ?? "none"}`)
    })

    // Create Estimate
    const result = await processEstimateInQb({
        draftOrderId,
        qbCustomerId: custResult.qbCustomerId!,
        items: qbItems,
        memo: `Draft Order ${draftOrderId}`,
    })

    if (result.error) {
        logger.error(`${LOG_PREFIX} ❌ processEstimateInQb error: ${result.error}`)
        return
    }

    if (result.skipped) {
        logger.info(`${LOG_PREFIX} ⏭️ Estimate skipped (QB disabled or no items)`)
        return
    }

    logger.info(`${LOG_PREFIX} ✅ Estimate created — TxnID=${result.txnId}, Ref=${result.refNumber}, OpID=${result.operationId}`)

    // Save estimate metadata to draft order
    if (result.txnId || result.operationId) {
        try {
            const orderModule = container.resolve(Modules.ORDER)
            const currentMetadata = draftOrder.metadata || {}

            await orderModule.updateDraftOrders?.(draftOrderId, {
                metadata: {
                    ...currentMetadata,
                    qb_list_id: custResult.qbCustomerId,         // ← Customer QB ID for downstream events
                    qb_estimate_txn_id: result.txnId || null,
                    qb_estimate_ref: result.refNumber || null,
                    qb_estimate_operation_id: result.operationId || null,
                    qb_synced_at: new Date().toISOString(),
                },
            })
            logger.info(`${LOG_PREFIX} ✅ Saved estimate metadata to draft order ${draftOrderId}`)
        } catch (metaErr: any) {
            logger.error(`${LOG_PREFIX} ⚠️ Failed to save draft order metadata: ${metaErr.message}`)
            logger.error(`${LOG_PREFIX} ⚠️ QB Estimate WAS created (TxnID=${result.txnId}) but metadata not saved. Manual update needed.`)
        }
    }
}

// ─── Subscriber Configuration ────────────────────────────────────────────────

export default qbDraftOrderSubscriber

export const config: SubscriberConfig = {
    event: [
        "draft_order.created",
    ],
    context: {
        subscriberId: "qb-draft-order-subscriber",
    },
}

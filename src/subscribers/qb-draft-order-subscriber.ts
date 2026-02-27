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
 *   qb_estimate_txn_id, qb_estimate_ref
 */

import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import { Modules, ContainerRegistrationKeys } from "@medusajs/framework/utils"
import {
    ensureCustomerInQb,
    buildQbItems,
    processEstimateInQb,
} from "../lib/quickbooks/order-flow-core"

const LOG_PREFIX = "[QB-DRAFT]"

// ─── Subscriber Handler ─────────────────────────────────────────────────────

async function qbDraftOrderSubscriber({ event, container }: SubscriberArgs<any>) {
    const logger = container.resolve(ContainerRegistrationKeys.LOGGER)

    try {
        if (event.name === "draft_order.created") {
            await handleDraftOrderCreated(event.data, container, logger)
        }
    } catch (err: any) {
        // QB failures must NEVER block the Medusa flow
        logger.error(`${LOG_PREFIX} ❌ Error handling ${event.name}: ${err.message}`)
    }
}

// ─── Event Handlers ──────────────────────────────────────────────────────────

async function handleDraftOrderCreated(data: any, container: any, logger: any) {
    const draftOrderId = data.id
    logger.info(`${LOG_PREFIX} draft_order.created → ${draftOrderId}`)

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

    // Ensure customer in QB
    const customer = draftOrder.customer
    if (!customer) {
        logger.warn(`${LOG_PREFIX} Draft order has no customer — skipping`)
        return
    }

    const custResult = await ensureCustomerInQb(customer, customerModule, (msg) => logger.info(msg))
    if (!custResult.success) {
        logger.error(`${LOG_PREFIX} ❌ ${custResult.error}`)
        return
    }

    // Build QB items
    const qbItems = buildQbItems(draftOrder.items)
    if (qbItems.length === 0) {
        logger.warn(`${LOG_PREFIX} No QB-linked items in draft order — skipping Estimate`)
        return
    }

    // Create Estimate
    const result = await processEstimateInQb({
        draftOrderId,
        qbCustomerId: custResult.qbCustomerId!,
        items: qbItems,
        memo: `Draft Order ${draftOrderId}`,
    })

    if (result.error) {
        logger.error(`${LOG_PREFIX} ❌ ${result.error}`)
        return
    }

    // Save estimate metadata to draft order
    if (result.txnId || result.operationId) {
        try {
            // Use query to update draft order metadata
            // (draft_order module may not have a direct updateDraftOrders method)
            const { data: updated } = await query.graph({
                entity: "draft_order",
                fields: ["id", "metadata"],
                filters: { id: draftOrderId },
            })
            const currentMetadata = updated?.[0]?.metadata || {}

            // Use raw SQL or the appropriate module method
            const orderModule = container.resolve(Modules.ORDER)
            await orderModule.updateDraftOrders?.(draftOrderId, {
                metadata: {
                    ...currentMetadata,
                    qb_estimate_txn_id: result.txnId || null,
                    qb_estimate_ref: result.refNumber || null,
                    qb_estimate_operation_id: result.operationId || null,
                    qb_synced_at: new Date().toISOString(),
                },
            })
            logger.info(`${LOG_PREFIX} ✅ Saved estimate metadata to draft order ${draftOrderId}`)
        } catch (metaErr: any) {
            logger.error(`${LOG_PREFIX} ⚠️ Failed to save draft order metadata: ${metaErr.message}`)
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

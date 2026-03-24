/**
 * qb-order-subscriber.ts
 *
 * Event-driven subscriber that connects Medusa order lifecycle events
 * to QuickBooks operations via the Bridge.
 *
 * Events handled:
 *   - order.placed           → Create Sales Order (or convert from Estimate)
 *   - order.payment_captured → Receive Payment (unapplied credit)
 *   - order.fulfillment_created → Create Invoice + Apply Payment
 *   - order.canceled         → Void Invoice / Close Sales Order
 *   - order.customer_transferred → Reassign QB documents to new customer
 *   - pos.invoice.created    → Create/Append POS Standalone Invoice
 *   - pos.invoice.voided     → Void a specific POS Invoice
 */

import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"

// ─── Event Handlers ──────────────────────────────────────────────────────────

import { handleOrderPlaced } from "../lib/quickbooks/handlers/handle-order-placed"
import { handlePaymentCaptured } from "../lib/quickbooks/handlers/handle-payment-captured"
import { handleFulfillmentCreated } from "../lib/quickbooks/handlers/handle-fulfillment-created"
import { handleOrderCanceled } from "../lib/quickbooks/handlers/handle-order-canceled"
import { handleInvoiceVoided } from "../lib/quickbooks/handlers/handle-invoice-voided"
import { handleCustomerTransferred } from "../lib/quickbooks/handlers/handle-customer-transferred"

export default async function qbOrderSubscriber({
    event: { name, data },
    container,
}: SubscriberArgs<any>) {
    const ENABLED = process.env.QB_ORDER_FLOW_ENABLED === "true"
    const orderModule = container.resolve("order")
    const customerModule = container.resolve("customer")
    const logger = container.resolve("logger")

    if (!ENABLED) {
        logger.info(`[QB-ORDER] ⏭️ QB_ORDER_FLOW_ENABLED is not true, skipping event ${name}`)
        return
    }

    try {
        logger.info(`[QB-ORDER] 📥 Dispatching event: ${name} with data: ${JSON.stringify(data)}`)
        switch (name) {
            case "order.placed":
                await handleOrderPlaced(data, orderModule, customerModule, container, logger)
                break
            case "order.payment_captured":
                await handlePaymentCaptured(data, orderModule, customerModule, logger)
                break
            case "order.fulfillment_created": {
                // Determine if this order is from the POS
                const orderIdStr = data.order_id || data.id
                if (orderIdStr) {
                    const query = container.resolve("query")
                    const { data: [fetchedOrder] } = await query.graph({
                        entity: "order",
                        fields: ["metadata"],
                        filters: { id: orderIdStr }
                    })
                    if (fetchedOrder?.metadata?.pos_created) {
                        logger.info(`[QB-ORDER] ⏭️ Skipping order.fulfillment_created for POS order ${orderIdStr}. POS invoices are strictly handled by direct-exec to bypass unreliable BullMQ outbox.`)
                        break
                    }
                }
                await handleFulfillmentCreated(data, orderModule, customerModule, container, logger)
                break
            }
            case "pos.invoice.created":
                await handleFulfillmentCreated(data, orderModule, customerModule, container, logger)
                break
            case "order.canceled":
                await handleOrderCanceled(data, orderModule, logger)
                break
            case "order.customer_transferred":
                await handleCustomerTransferred(data, orderModule, logger)
                break
            case "pos.invoice.voided":
                await handleInvoiceVoided(data, orderModule, logger)
                break
            default:
                logger.warn(`[QB-ORDER] ⚠️ Unhandled event type: ${name}`)
        }
    } catch (err: any) {
        logger.error(`[QB-ORDER] ❌ Unhandled error in qbOrderSubscriber for ${name}: ${err.message}`)
        if (err.stack) logger.error(err.stack)
    }
}

// ─── Subscriber Configuration ────────────────────────────────────────────────

export const config: SubscriberConfig = {
    event: [
        "order.placed",
        "order.payment_captured",
        "order.fulfillment_created",
        "order.canceled",
        "pos.invoice.created",
        "pos.invoice.voided",
    ],
    context: {
        subscriberId: "qb-order-subscriber",
    },
}


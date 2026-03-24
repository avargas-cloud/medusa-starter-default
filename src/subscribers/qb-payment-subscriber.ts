import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import { handlePosPaymentCreated } from "../lib/quickbooks/handlers/handle-pos-payment-created"
import { handlePosPaymentApplied } from "../lib/quickbooks/handlers/handle-pos-payment-applied"

export default async function qbPaymentSubscriber({
    event: { name, data },
    container,
}: SubscriberArgs<any>) {
    const ENABLED = process.env.QB_ORDER_FLOW_ENABLED === "true"
    const logger = container.resolve("logger")

    if (!ENABLED) {
        logger.info(`[QB-PAYMENT] ⏭️ QB_ORDER_FLOW_ENABLED is not true, skipping event ${name}`)
        return
    }

    try {
        logger.info(`[QB-PAYMENT] 📥 Dispatching event: ${name} with data: ${JSON.stringify(data)}`)
        switch (name) {
            case "pos.payment.created":
                await handlePosPaymentCreated({ event: { name, data }, container } as SubscriberArgs<any>)
                break
            case "pos.payment.applied":
                await handlePosPaymentApplied({ event: { name, data }, container } as SubscriberArgs<any>)
                break
            default:
                logger.warn(`[QB-PAYMENT] ⚠️ Unhandled event type: ${name}`)
        }
    } catch (err: any) {
        logger.error(`[QB-PAYMENT] ❌ Unhandled error in qbPaymentSubscriber for ${name}: ${err.message}`)
        if (err.stack) logger.error(err.stack)
    }
}

export const config: SubscriberConfig = {
    event: [
        "pos.payment.created",
        "pos.payment.applied",
    ],
    context: {
        subscriberId: "qb-payment-subscriber",
    },
}

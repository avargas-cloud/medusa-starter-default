import { SubscriberArgs, type SubscriberConfig } from "@medusajs/framework"
import { capturePaymentWorkflow } from "@medusajs/core-flows"

/**
 * Subscriber: order.placed (web orders only)
 *
 * Automatically captures the Medusa payment record for every web order
 * immediately after it is placed. This ensures:
 *
 *   1. `payment.captured` event fires → finance ledger gets the entry
 *   2. The POS can process the order with payment already captured
 *   3. No manual "Mark as Paid" in the admin panel is needed
 *
 * The actual funds were already captured at Authorize.net during
 * `authorizePayment` (authCaptureTransaction). This step only syncs
 * Medusa's internal payment state to match reality.
 *
 * POS orders are skipped — their payment flow goes through pos.payment.created.
 */
export default async function autoCaptureWebPayment({
  event: { data },
  container,
}: SubscriberArgs<{ id: string }>) {
  const orderId = data.id
  if (!orderId) return

  const query = container.resolve("query")
  const logger = container.resolve("logger")

  // 1. Fetch the order with its payment collections
  const { data: orders } = await query.graph({
    entity: "order",
    fields: [
      "id",
      "metadata",
      "payment_collections.payments.id",
      "payment_collections.payments.provider_id",
    ],
    filters: { id: orderId },
  })

  const order = orders?.[0]
  if (!order) return

  // 2. Skip POS orders — handled separately via pos.payment.created
  if (order.metadata?.pos_created === true) return

  // 3. Capture each authorized payment
  const payments: Array<{ id: string; provider_id: string }> = []
  for (const pc of order.payment_collections ?? []) {
    for (const p of (pc?.payments ?? [])) {
      if (p?.id) payments.push(p)
    }
  }

  if (payments.length === 0) {
    logger.warn(`[AutoCapture] No payments found for order ${orderId}`)
    return
  }

  for (const payment of payments) {
    try {
      await capturePaymentWorkflow(container).run({
        input: { payment_id: payment.id },
      })
      logger.info(`[AutoCapture] ✅ Captured payment ${payment.id} for order ${orderId}`)
    } catch (err: any) {
      logger.error(`[AutoCapture] ❌ Failed to capture payment ${payment.id}: ${err.message}`)
    }
  }
}

export const config: SubscriberConfig = {
  event: "order.placed",
  context: {
    subscriberId: "auto-capture-web-payment",
  },
}

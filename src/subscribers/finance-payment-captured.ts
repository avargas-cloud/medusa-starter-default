import { SubscriberArgs, type SubscriberConfig } from "@medusajs/framework"
import { FINANCE_MODULE } from "../modules/finance"

/**
 * Subscriber: order.payment_captured
 * 
 * Captures online payments (e.g., Stripe via web checkout) and creates a 
 * tracking record in the CustomerPayment module.
 * 
 * Flow:
 * 1. Checkout completes and captures payment via Medusa core
 * 2. This subscriber triggers, looking up the order and its customer
 * 3. It checks for idempotency using medusa_payment_id
 * 4. It creates a `source: 'web'` CustomerPayment mapped direct to the order
 */
export default async function financePaymentCapturedHandler({
  event: { data },
  container,
}: SubscriberArgs<{ id: string }>) {
  const orderId = data.id

  if (!orderId) {
    return
  }

  const query = container.resolve("query")
  const financeService = container.resolve(FINANCE_MODULE)

  // 1. Fetch the order to get the customer ID and payment collection
  const { data: orders } = await query.graph({
    entity: "order",
    fields: [
      "id", 
      "customer_id",
      "payment_collections.*",
      "payment_collections.payments.*"
    ],
    filters: {
      id: orderId,
    },
  })

  if (!orders || orders.length === 0) {
    console.error(`[financePaymentCapturedHandler] Order ${orderId} not found`)
    return
  }

  const order = orders[0]
  if (!order || !order.customer_id) {
    console.warn(`[financePaymentCapturedHandler] Order ${orderId} has no customer linked. Skipping AR ledger.`)
    return
  }

  // 2. Extract the actual payment that was just captured.
  // We need to look inside the order's payment collections to find the latest captured payment
  let latestPayment = null
  if (order && order.payment_collections && order.payment_collections.length > 0) {
    for (const pc of order.payment_collections) {
      if (pc && pc.payments && pc.payments.length > 0) {
        // Just take the first captured payment. 
        // In a complex split payment scenario this might need to map all of them,
        // but typically it's one auth -> one capture.
        latestPayment = pc.payments.find((p: any) => p && p.captured_at !== null) || pc.payments[0]
      }
    }
  }

  if (!latestPayment) {
    console.warn(`[financePaymentCapturedHandler] No payment found in order ${orderId}.`)
    return
  }
  // Medusa v2 native returns real amounts (dollars) for captured payments.
  // We MUST convert it to CENTS for the Finance AR Ledger so it mathematically aligns with Invoices!
  const medusaPaymentId = latestPayment.id
  const amountToRecord = Math.round(Number(latestPayment.amount) * 100)

  // 3. Idempotency Check: Did we already record this exact medusa_payment_id?
  const existingRecords = await financeService.listCustomerPayments({
    medusa_payment_id: medusaPaymentId
  })

  if (existingRecords && existingRecords.length > 0) {
    console.log(`[financePaymentCapturedHandler] Payment ${medusaPaymentId} already exists in finance ledger. Skipping.`)
    return
  }

  // 4. Create the mirror record
  try {
    await financeService.createCustomerPayments({
      customer_id: order!.customer_id as string,
      amount: amountToRecord,
      method: 'card', // For web checkout it's usually card, though we could try to map the provider_id
      reference: latestPayment.provider_id || null, // e.g. 'stripe'
      received_at: latestPayment.captured_at ? new Date(latestPayment.captured_at) : new Date(),
      created_by: 'system',
      source: 'web',
      type: 'payment',
      status: 'available', // Web payments are available until invoiced by POS
      medusa_payment_id: medusaPaymentId,
      locked_order_id: orderId
    })

    console.log(`[financePaymentCapturedHandler] Successfully mirrored web payment ${medusaPaymentId} to customer ${order.customer_id} as available credit.`)

    console.log(`[financePaymentCapturedHandler] Successfully mirrored web payment ${medusaPaymentId} to customer ${order.customer_id} ledger.`)
  } catch (err: any) {
    console.error(`[financePaymentCapturedHandler] Error replicating payment to finance ledger:`, err.message)
  }
}

export const config: SubscriberConfig = {
  event: "order.payment_captured",
}

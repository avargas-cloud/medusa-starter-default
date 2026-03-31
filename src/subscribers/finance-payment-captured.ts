import { SubscriberArgs, type SubscriberConfig } from "@medusajs/framework"
import { FINANCE_MODULE } from "../modules/finance"

/**
 * Subscriber: payment.captured
 *
 * Medusa v2 emits `payment.captured` (NOT `order.payment_captured`) with:
 *   data: { id: paymentId }
 *
 * This handler mirrors the captured web payment into the Finance AR Ledger
 * so POS staff can see the available credit against the customer's account.
 *
 * Flow:
 * 1. Medusa captures payment → emits payment.captured { id: paymentId }
 * 2. We fetch the payment to get amount, provider, captured_at
 * 3. We traverse to the parent order to get customer_id and order_id
 * 4. Idempotency check on medusa_payment_id
 * 5. Create CustomerPayment record with source='web', status='available'
 *
 * Amount: Medusa v2 stores amounts in the smallest currency unit (cents).
 * No conversion needed — store as-is to match POS invoices.
 */
export default async function financePaymentCapturedHandler({
  event: { data },
  container,
}: SubscriberArgs<{ id: string }>) {
  const paymentId = data.id

  if (!paymentId) {
    return
  }

  const query = container.resolve("query")
  const financeService = container.resolve(FINANCE_MODULE)

  // 1. Fetch the payment details
  const { data: payments } = await query.graph({
    entity: "payment",
    fields: ["id", "amount", "captured_at", "provider_id", "payment_collection_id"],
    filters: { id: paymentId },
  })

  const payment = payments?.[0]
  if (!payment) {
    console.error(`[financePaymentCapturedHandler] Payment ${paymentId} not found`)
    return
  }

  // 2. Find the order that owns this payment (via payment_collection).
  // Use payment_collection_id from the payment to traverse up to the order.
  const { data: orders } = await query.graph({
    entity: "order",
    fields: ["id", "customer_id"],
    filters: {
      payment_collections: { id: payment.payment_collection_id },
    } as any,
  })

  const order = orders?.[0]
  if (!order) {
    console.warn(`[financePaymentCapturedHandler] No order found for payment ${paymentId}. Skipping.`)
    return
  }

  if (!order.customer_id) {
    console.warn(`[financePaymentCapturedHandler] Order ${order.id} has no customer linked (guest checkout). Skipping AR ledger.`)
    return
  }

  // 3. Idempotency check
  const existingRecords = await financeService.listCustomerPayments({
    medusa_payment_id: paymentId,
  })

  if (existingRecords && existingRecords.length > 0) {
    console.log(`[financePaymentCapturedHandler] Payment ${paymentId} already in finance ledger. Skipping.`)
    return
  }

  // 4. Create the ledger entry
  // Amounts in Medusa v2 are already in the smallest currency unit (cents) — no conversion needed.
  try {
    await financeService.createCustomerPayments({
      customer_id: order.customer_id as string,
      amount: Number(payment.amount),
      method: 'card',
      reference: payment.provider_id || null,
      received_at: payment.captured_at ? new Date(payment.captured_at as string) : new Date(),
      created_by: 'system',
      source: 'web',
      type: 'payment',
      status: 'available',
      medusa_payment_id: paymentId,
      medusa_payment_synced: true,
      locked_order_id: order.id,
    })

    console.log(`[financePaymentCapturedHandler] Mirrored payment ${paymentId} → customer ${order.customer_id}, order ${order.id}`)
  } catch (err: any) {
    console.error(`[financePaymentCapturedHandler] Error creating finance ledger entry:`, err.message)
  }
}

export const config: SubscriberConfig = {
  event: "payment.captured",
}

import { SubscriberArgs, type SubscriberConfig } from "@medusajs/framework";

import { FINANCE_MODULE } from "../modules/finance";

/**
 * Subscriber: order.refund_created
 *
 * Captures refunds processed by Medusa (e.g. from a web order return via Stripe)
 * and records them in the Customer AR Ledger as "refunds".
 */
export default async function financeRefundCreatedHandler({
  event: { data },
  container,
}: SubscriberArgs<{ id: string }>) {
  const refundId = data.id;

  if (!refundId) {
    return;
  }

  const query = container.resolve("query");
  const financeService = container.resolve(FINANCE_MODULE);

  // 1. Fetch the refund to get its details, amount, and the related order/customer
  const { data: refunds } = await query.graph({
    entity: "refund",
    fields: ["id", "amount", "payment_id", "order_id"],
    filters: {
      id: refundId,
    },
  });

  if (!refunds || refunds.length === 0) {
    console.error(`[financeRefundCreatedHandler] Refund ${refundId} not found`);
    return;
  }

  const refund = refunds[0];
  if (!refund) return;
  const orderId = (refund as any).order_id;

  // 1b. Get the order to find the customer
  const { data: orders } = await query.graph({
    entity: "order",
    fields: ["id", "customer_id"],
    filters: { id: orderId },
  });

  if (!orders || orders.length === 0) {
    return;
  }
  const order = orders[0];

  if (!order || !order.customer_id) {
    console.warn(
      `[financeRefundCreatedHandler] Order ${orderId} has no customer linked. Skipping AR ledger for refund.`
    );
    return;
  }

  // 2. Idempotency Check
  const existingRecords = await financeService.listCustomerPayments({
    medusa_refund_id: refundId,
  });

  if (existingRecords && existingRecords.length > 0) {
    console.log(
      `[financeRefundCreatedHandler] Refund ${refundId} already exists in finance ledger. Skipping.`
    );
    return;
  }

  // 3. Create the mirror record for the refund
  // A refund is a negative impact on the store, but in the AR ledger, it means
  // we are 'giving back' the money we took. The customer balance isn't affected directly
  // unless we issued it as store credit (which would be pos 'available').
  // For web refunds, the money went back to their card, so it's a closed matter.
  try {
    const customerPayment = await financeService.createCustomerPayments({
      customer_id: order.customer_id,
      amount: refund.amount,
      method: "card",
      received_at: new Date(),
      created_by: "system",
      source: "web",
      type: "refund",
      status: "applied", // Web refunds are instantly consumed
      medusa_refund_id: refundId,
      locked_order_id: orderId,
    });

    // We still link it to the order for tracking via a PaymentApplication
    await financeService.createPaymentApplications({
      payment_id: customerPayment.id,
      invoice_id: null,
      order_id: orderId,
      amount_applied: refund.amount,
      applied_at: new Date(),
      applied_by: "system",
    });

    console.log(
      `[financeRefundCreatedHandler] Successfully mirrored refund ${refundId} to customer ${order.customer_id} ledger.`
    );
  } catch (err: any) {
    console.error(
      `[financeRefundCreatedHandler] Error replicating refund to finance ledger:`,
      err.message
    );
  }
}

export const config: SubscriberConfig = {
  event: "order.refund_created",
};

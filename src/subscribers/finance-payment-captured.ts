import { SubscriberArgs, type SubscriberConfig } from "@medusajs/framework";
import { Modules } from "@medusajs/utils";

import { FINANCE_MODULE } from "../modules/finance";
import { buildOrderCostSnapshot } from "../lib/finance/build-order-cost-snapshot";

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
  const paymentId = data.id;

  if (!paymentId) {
    return;
  }

  const query = container.resolve("query");
  const paymentModule = container.resolve(Modules.PAYMENT);
  const financeService = container.resolve(FINANCE_MODULE);

  // 1. Fetch payment via the Payment module (more reliable than query.graph for payment entity)
  let payment: any;
  try {
    payment = await paymentModule.retrievePayment(paymentId, {
      select: [
        "id",
        "amount",
        "captured_at",
        "provider_id",
        "payment_collection_id",
      ],
    });
  } catch (err: any) {
    console.error(
      `[financePaymentCapturedHandler] Payment ${paymentId} not found: ${err.message}`
    );
    return;
  }

  if (!payment?.payment_collection_id) {
    console.warn(
      `[financePaymentCapturedHandler] Payment ${paymentId} has no payment_collection_id. Skipping.`
    );
    return;
  }

  // 2. Find the order via payment_collection_id
  const { data: orders } = await query.graph({
    entity: "order",
    fields: ["id", "customer_id"],
    filters: {
      payment_collections: { id: payment.payment_collection_id },
    } as any,
  });

  const order = orders?.[0];
  if (!order) {
    console.warn(
      `[financePaymentCapturedHandler] No order found for payment ${paymentId}. Skipping.`
    );
    return;
  }

  if (!order.customer_id) {
    console.warn(
      `[financePaymentCapturedHandler] Order ${order.id} has no customer linked (guest checkout). Skipping AR ledger.`
    );
    return;
  }

  // 3. Idempotency check
  const existingRecords = await financeService.listCustomerPayments({
    medusa_payment_id: paymentId,
  });

  if (existingRecords && existingRecords.length > 0) {
    console.log(
      `[financePaymentCapturedHandler] Payment ${paymentId} already in finance ledger. Skipping.`
    );
    return;
  }

  // 4. Create the ledger entry
  // Amounts in Medusa v2 are already in the smallest currency unit (cents) — no conversion needed.
  // Web payments are immediately "applied" to their source order (model doc: web =
  // immediately applied) — they never go through the PosInvoice flow.
  try {
    const amountCents = Number(payment.amount);
    const customerPayment = await financeService.createCustomerPayments({
      customer_id: order.customer_id as string,
      amount: amountCents,
      method: "card",
      reference: payment.provider_id || null,
      received_at: payment.captured_at
        ? new Date(payment.captured_at as string)
        : new Date(),
      created_by: "system",
      source: "web",
      type: "payment",
      status: "applied",
      medusa_payment_id: paymentId,
      medusa_payment_synced: true,
      locked_order_id: order.id,
    });

    // 5. Link the payment to its order via a real order-only PaymentApplication
    //    (invoice_id = NULL). Web orders never get a PosInvoice, so this stays
    //    order-only permanently — making the sale visible to Treasury (revenue +
    //    COGS) instead of dumping the cash into Operating. We freeze the per-line
    //    cost basis now (cost_snapshot) so the closed day's COGS won't drift when
    //    POs are received later. No QB enqueue (order-only never posts to QB).
    try {
      const pg = container.resolve("__pg_connection__") as Parameters<
        typeof buildOrderCostSnapshot
      >[0];
      const costSnapshot = await buildOrderCostSnapshot(pg, order.id as string);
      await financeService.createPaymentApplications({
        payment_id: (customerPayment as { id: string }).id,
        invoice_id: null,
        invoice_number: null,
        order_id: order.id as string,
        amount_applied: amountCents,
        applied_at: new Date(),
        applied_by: "system:web-capture",
        cost_snapshot: costSnapshot,
      });
    } catch (linkErr: any) {
      console.error(
        `[financePaymentCapturedHandler] Payment ${paymentId} recorded but order-link (PaymentApplication) failed: ${linkErr.message}`
      );
    }

    console.log(
      `[financePaymentCapturedHandler] Mirrored payment ${paymentId} → customer ${order.customer_id}, order ${order.id}`
    );
  } catch (err: any) {
    console.error(
      `[financePaymentCapturedHandler] Error creating finance ledger entry:`,
      err.message
    );
  }
}

export const config: SubscriberConfig = {
  event: "payment.captured",
};

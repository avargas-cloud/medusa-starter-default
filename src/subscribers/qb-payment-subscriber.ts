import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework";
import { handlePosPaymentUnapplied } from "../lib/quickbooks/handlers/handle-pos-payment-unapplied";

// ⚠️ ARCHITECTURE NOTE:
// pos.payment.created  → handled DIRECTLY in /api/admin/finance/payments/route.ts  (setTimeout)
// pos.payment.applied  → handled DIRECTLY in /api/admin/invoices/route.ts           (setTimeout)
// Both were moved out of BullMQ to prevent the outbox from silently dropping events.
// Do NOT re-add those events here — it causes duplicate QB payments.

export default async function qbPaymentSubscriber({
  event: { name, data },
  container,
}: SubscriberArgs<any>) {
  const ENABLED = process.env.QB_ORDER_FLOW_ENABLED === "true";
  const logger = container.resolve("logger");

  if (!ENABLED) {
    logger.info(
      `[QB-PAYMENT] ⏭️ QB_ORDER_FLOW_ENABLED is not true, skipping event ${name}`
    );
    return;
  }

  try {
    logger.info(
      `[QB-PAYMENT] 📥 Dispatching event: ${name} with data: ${JSON.stringify(data)}`
    );
    switch (name) {
      case "pos.payment.unapplied":
        await handlePosPaymentUnapplied({
          event: { name, data },
          container,
        } as SubscriberArgs<any>);
        break;
      default:
        logger.warn(`[QB-PAYMENT] ⚠️ Unhandled event type: ${name}`);
    }
  } catch (err: any) {
    logger.error(
      `[QB-PAYMENT] ❌ Unhandled error in qbPaymentSubscriber for ${name}: ${err.message}`
    );
    if (err.stack) logger.error(err.stack);
  }
}

export const config: SubscriberConfig = {
  event: [
    // pos.payment.created  ← direct exec in finance/payments/route.ts
    // pos.payment.applied  ← direct exec in invoices/route.ts
    "pos.payment.unapplied",
  ],
  context: {
    subscriberId: "qb-payment-subscriber",
  },
};

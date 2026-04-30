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

import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework";

// ─── Event Handlers ──────────────────────────────────────────────────────────

import { handleCustomerTransferred } from "../lib/quickbooks/handlers/handle-customer-transferred";
import { handleFulfillmentCreated } from "../lib/quickbooks/handlers/handle-fulfillment-created";
import { handleInvoiceVoided } from "../lib/quickbooks/handlers/handle-invoice-voided";
import { handleOrderCanceled } from "../lib/quickbooks/handlers/handle-order-canceled";
// 1.5.5: handleOrderPlaced import removed — subscriber enqueues now.
import { handlePaymentCaptured } from "../lib/quickbooks/handlers/handle-payment-captured";
import { isPosOrder } from "../lib/quickbooks/handlers/utils";

export default async function qbOrderSubscriber({
  event: { name, data },
  container,
}: SubscriberArgs<any>) {
  const ENABLED = process.env.QB_ORDER_FLOW_ENABLED === "true";
  const orderModule = container.resolve("order");
  const customerModule = container.resolve("customer");
  const logger = container.resolve("logger");

  if (!ENABLED) {
    logger.info(
      `[QB-ORDER] ⏭️ QB_ORDER_FLOW_ENABLED is not true, skipping event ${name}`
    );
    return;
  }

  try {
    logger.info(
      `[QB-ORDER] 📥 Dispatching event: ${name} with data: ${JSON.stringify(data)}`
    );
    switch (name) {
      case "order.placed": {
        // 1.5.5: pipeline-only — enqueue 'pending' SO row.
        // Consolidator picks up via pending-dispatch and calls
        // handleOrderUpdated (MOD-first) → handleOrderPlaced (CREATE fallback).
        const orderId = (data as any).id;
        const {
          writePipelineRow,
        } = require("../lib/quickbooks/qb-pipeline");
        await writePipelineRow({
          orderId,
          step: "sales_order",
          status: "pending",
        });
        logger.info(
          `[QB-ORDER] 📥 Enqueued sales_order for ${orderId} (consolidator will process)`
        );
        break;
      }
      case "order.payment_captured": {
        // Web orders: handled synchronously by the maintain-cart-prices hook
        // (which fires as part of completeCartWorkflow and is more reliable than the event bus).
        // Only process here for POS orders that go through manual payment capture.
        const paymentOrderId = data.id || data.order_id;
        if (paymentOrderId) {
          const paymentQuery = container.resolve("query");
          const {
            data: [paymentOrder],
          } = await paymentQuery.graph({
            entity: "order",
            fields: ["metadata", "sales_channel_id"],
            filters: { id: paymentOrderId },
          });
          if (!isPosOrder(paymentOrder)) {
            logger.info(
              `[QB-ORDER] ⏭️ Skipping order.payment_captured for web order ${paymentOrderId} — handled by maintain-cart-prices hook.`
            );
            break;
          }
        }
        await handlePaymentCaptured(data, orderModule, customerModule, logger);
        break;
      }
      case "order.fulfillment_created": {
        // Determine if this order is from the POS
        const orderIdStr = data.order_id || data.id;
        if (orderIdStr) {
          const query = container.resolve("query");
          const {
            data: [fetchedOrder],
          } = await query.graph({
            entity: "order",
            fields: ["metadata", "sales_channel_id"],
            filters: { id: orderIdStr },
          });
          if (isPosOrder(fetchedOrder)) {
            logger.info(
              `[QB-ORDER] ⏭️ Skipping order.fulfillment_created for POS order ${orderIdStr}. POS invoices are strictly handled by direct-exec to bypass unreliable BullMQ outbox.`
            );
            break;
          }
        }
        await handleFulfillmentCreated(
          data,
          orderModule,
          customerModule,
          container,
          logger
        );
        break;
      }
      case "pos.invoice.created":
        await handleFulfillmentCreated(
          data,
          orderModule,
          customerModule,
          container,
          logger
        );
        break;
      case "order.canceled":
        await handleOrderCanceled(data, orderModule, logger);
        break;
      case "order.customer_transferred":
        await handleCustomerTransferred(data, orderModule, logger);
        break;
      case "pos.invoice.voided":
        await handleInvoiceVoided(data, orderModule, logger, container);
        break;
      default:
        logger.warn(`[QB-ORDER] ⚠️ Unhandled event type: ${name}`);
    }
  } catch (err: any) {
    logger.error(
      `[QB-ORDER] ❌ Unhandled error in qbOrderSubscriber for ${name}: ${err.message}`
    );
    if (err.stack) logger.error(err.stack);
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
    "order.customer_transferred",
  ],
  context: {
    subscriberId: "qb-order-subscriber",
  },
};

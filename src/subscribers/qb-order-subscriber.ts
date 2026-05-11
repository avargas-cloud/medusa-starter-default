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
// 1.5.7: handleFulfillmentCreated import removed — subscriber enqueues now.
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
        // POS orders skip here — convert-force already wrote a 'waiting' row and
        // qb-pos-sync promotes it after 1 hour (only if no invoice/SR exists).
        // Immediately promoting to 'pending' would bypass the 1h delay and create
        // the SO before the cashier has a chance to invoice the order.
        const orderId = (data as any).id;
        const placedQuery = container.resolve("query");
        const {
          data: [placedOrder],
        } = await placedQuery.graph({
          entity: "order",
          fields: ["metadata", "sales_channel_id"],
          filters: { id: orderId },
        });
        if (isPosOrder(placedOrder)) {
          logger.info(
            `[QB-ORDER] ⏭️ POS order ${orderId} — SO stays 'waiting', qb-pos-sync handles after 1h`
          );
          break;
        }
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
        // 1.5.7: pipeline-only — enqueue 'invoice' for consolidator pickup.
        const {
          writePipelineRow: enqueueInv1,
        } = require("../lib/quickbooks/qb-pipeline");
        const invPayload1 = { ...(data as any) };
        delete invPayload1.order_id;
        await enqueueInv1({
          orderId: (data as any).order_id ?? (data as any).id,
          referenceId: (data as any).fulfillment_id ?? (data as any).invoice_id ?? null,
          referenceType: (data as any).fulfillment_id ? "fulfillment" : "invoice",
          step: "invoice",
          status: "pending",
          payload: invPayload1,
        });
        logger.info(
          `[QB-ORDER] 📥 Enqueued invoice for ${(data as any).order_id ?? (data as any).id}`
        );
        break;
      }
      case "pos.invoice.created": {
        // The route POST /admin/invoices already enqueues the correct pipeline
        // row upfront (sales_receipt OR invoice depending on is_sales_receipt).
        // When the SR path is taken upfront, this event must NOT enqueue a
        // duplicate "invoice" row — that path produced ghost QB Invoices like
        // #19480 (memo "Invoice 1651") for order 1651 / pos_invoice 20245.
        if ((data as any).is_sales_receipt === true) {
          logger.info(
            `[QB-ORDER] ⏭️  pos.invoice.created skipped — SR path already enqueued upfront for ${(data as any).order_id ?? (data as any).id}`
          );
          break;
        }
        // 1.5.7 / partial-invoice fix (2026-05-11):
        // POST /admin/invoices already enqueues the invoice row with the
        // full payload {invoice_id, items, fulfillment_id}. The event data
        // here only carries {id, invoice_id, is_sales_receipt} — enqueueing
        // it would stomp the route's payload via COALESCE($payload, payload),
        // erasing items/fulfillment_id and causing handleFulfillmentCreated
        // to fall back to ALL order.items at full SO quantities (root cause
        // of QB Invoice 19507 receiving 7 lines for partial POS invoice 20330).
        //
        // Back-compat: still enqueue, but WITHOUT a payload, so the upsert
        // updates status only and preserves the rich payload the route wrote.
        const {
          writePipelineRow: enqueueInv2,
        } = require("../lib/quickbooks/qb-pipeline");
        await enqueueInv2({
          orderId: (data as any).order_id ?? (data as any).id,
          referenceId: (data as any).invoice_id ?? null,
          referenceType: "invoice",
          step: "invoice",
          status: "pending",
        });
        logger.info(
          `[QB-ORDER] 📥 Enqueued POS invoice for ${(data as any).order_id ?? (data as any).id} (payload preserved from route)`
        );
        break;
      }
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

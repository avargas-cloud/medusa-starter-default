import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework";

import { maybeCompleteOrder } from "../lib/maybe-complete-order";

/**
 * Event-driven native order completion. Runs the idempotent maybeCompleteOrder
 * guard on every real eligibility edge so an order closes the moment ALL
 * conditions hold — replacing the old fragile one-shot setTimeout in the invoice
 * route (which had no retry; see lib/maybe-complete-order.ts).
 *
 * Edges (each carries the order id as order_id or id):
 *   pos.invoice.created          { order_id }   — invoice now exists
 *   order-edit.confirmed         { order_id }   — edit settled (version bump)
 *   order.fulfillment_created    { order_id }   — goods fulfilled
 *   order.placed                 { id }
 *   order.updated                { id }         — cheap retry net (covers the QB
 *                                                 metadata writeback, etc.)
 *
 * NOT subscribed:
 *   - order.payment_captured: Medusa core never emits it (registerMedusaPayment
 *     captures via the payment module directly). Payment settlement is covered
 *     by the direct maybeCompleteOrder calls in the invoice + payment-apply
 *     routes, and by order.updated (QB writeback after the apply).
 *   - delivery.created / shipment.created: carry a fulfillment id (not an order
 *     id), and shipping doesn't change eligibility inputs. The pickup path calls
 *     the helper directly.
 *
 * Completing emits `order.completed` (not `order.updated`) → no loop. The helper
 * holds a session advisory lock + re-checks `pending`, so the burst of
 * order.updated events during an edit can't double-complete.
 */
type AnyOrderEvent = {
  id?: string;
  order_id?: string;
};

export default async function autoCompleteOrderSubscriber({
  event: { name, data },
  container,
}: SubscriberArgs<AnyOrderEvent>) {
  const orderId = data?.order_id ?? data?.id;
  if (!orderId?.startsWith("order_")) return;

  try {
    const result = await maybeCompleteOrder(container, orderId);
    if (result.completed) {
      console.log(`[auto-complete] order ${orderId} completed via ${name}`);
    }
  } catch (err: any) {
    // maybeCompleteOrder never throws, but stay defensive — never block events.
    console.warn(
      `[auto-complete] soft-fail on ${name} for ${orderId}: ${err?.message?.slice(0, 100)}`
    );
  }
}

export const config: SubscriberConfig = {
  event: [
    "pos.invoice.created",
    "order-edit.confirmed",
    "order.fulfillment_created",
    "order.placed",
    "order.updated",
  ],
};

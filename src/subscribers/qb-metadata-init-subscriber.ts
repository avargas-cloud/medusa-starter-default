/**
 * qb-metadata-init-subscriber.ts
 *
 * Initializes the QuickBooks metadata fields on draft orders as soon
 * as they are created (or updated while still in draft status).
 *
 * WHY: In Medusa v2, draft orders do not have a standalone "draft_order.created"
 * event. Instead, they are Orders with status="draft" and the Admin UI creates
 * them step-by-step using order_edit flows. The `order.updated` event fires
 * after each step (item added, shipping added, etc.).
 *
 * This subscriber listens for `order.updated` and — if the order is a draft
 * that does NOT yet have QB metadata — initializes those fields to null, so
 * they appear in the Admin metadata panel and the QB widget.
 *
 * Fields initialized:
 *   metadata.qb_estimate_ref   — Human-readable QB estimate number (e.g. EST-1042)
 *   metadata.qb_estimate_txn_id — Internal QB transaction ID
 */

import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework";
import { Modules } from "@medusajs/utils";

export default async function qbMetadataInitSubscriber({
  event: { data },
  container,
}: SubscriberArgs<{ id: string }>) {
  const orderId: string = data.id;
  if (!orderId) return;

  try {
    const orderModule = container.resolve(Modules.ORDER);

    const order = await orderModule.retrieveOrder(orderId, {
      select: ["id", "status", "metadata"],
    });

    // Only process draft orders
    if (order.status !== "draft") return;

    // Skip if QB metadata already initialized
    const meta = (order.metadata || {}) as Record<string, any>;
    if ("qb_estimate_ref" in meta || "qb_estimate_txn_id" in meta) return;

    // Initialize QB metadata fields to null
    await orderModule.updateOrders(orderId, {
      metadata: {
        ...meta,
        qb_estimate_ref: null,
        qb_estimate_txn_id: null,
      },
    });

    console.log(
      `[QB-INIT] ✅ Initialized QB metadata for draft order ${orderId}`
    );
  } catch (err: any) {
    // Non-fatal — just log and move on
    console.error(
      `[QB-INIT] ⚠️ Could not initialize QB metadata for order ${orderId}: ${err.message}`
    );
  }
}

export const config: SubscriberConfig = {
  event: "order.updated",
};

import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework";

import {
  buildOrderDoc,
  type OrderForMeili,
} from "../lib/meilisearch/build-order-doc";

/**
 * AUTO-SYNC ORDER → MEILISEARCH
 *
 * Keeps the `orders` index in step with the database for the POS
 * /orders search bar (placeholder: "Search by #, customer, company,
 * email or phone…").
 *
 * Events handled:
 *   • order.placed / order.updated / order.canceled
 *       → upsert the affected order
 *   • delivery.created
 *       → a fulfillment was marked delivered. Payload carries the
 *         FULFILLMENT id (not the order id), so we resolve the owning
 *         order first, then upsert. Without this the doc reindexed on
 *         order.fulfillment_created races the delivered_at write and can
 *         stick at is_open=true even after the order is delivered.
 *   • order.archived / order.deleted
 *       → drop from index
 *   • customer.updated
 *       → cascade: re-sync every order for that customer (so name/phone
 *         changes propagate to the search index immediately)
 *
 * The doc shape is centralized in lib/meilisearch/build-order-doc.ts.
 * Index settings live in medusa-config.ts. The plugin re-applies them
 * on startup; this subscriber only writes documents.
 */

const ORDERS_INDEX = "orders";

const ORDER_FIELDS = [
  "id",
  "display_id",
  "status",
  "is_draft_order",
  "payment_status",
  "fulfillment_status",
  "email",
  "total",
  "canceled_at",
  "created_at",
  "updated_at",
  "metadata",
  "summary.current_order_total",
  "payment_collections.captured_amount",
  "payment_collections.refunded_amount",
  "customer.first_name",
  "customer.last_name",
  "customer.email",
  "customer.phone",
  "customer.company_name",
  "billing_address.company",
  "billing_address.phone",
  "shipping_address.company",
  "shipping_address.phone",
  "sales_channel.id",
  "sales_channel.name",
  // Needed for the local fulfillment_status compute in buildOrderDoc —
  // query.graph drops the top-level fulfillment_status field.
  "fulfillments.packed_at",
  "fulfillments.shipped_at",
  "fulfillments.delivered_at",
  "fulfillments.canceled_at",
];

async function getMeili() {
  const { MeiliSearch } = await import("meilisearch");
  return new MeiliSearch({
    host: process.env.MEILISEARCH_HOST!,
    apiKey: process.env.MEILISEARCH_API_KEY!,
  });
}

async function syncOrders(
  orderIds: string[],
  container: any,
  logger: any
): Promise<void> {
  if (orderIds.length === 0) return;

  try {
    const query = container.resolve("query");
    const { data } = await query.graph({
      entity: "order",
      fields: ORDER_FIELDS,
      filters: { id: orderIds },
    });

    if (!data || data.length === 0) {
      logger.warn(
        `[MEILI-ORDER-SYNC] no orders returned for ids: ${orderIds.join(",")}`
      );
      return;
    }

    const docs = (data as OrderForMeili[]).map((o) => buildOrderDoc(o));

    const meili = await getMeili();
    await meili.index(ORDERS_INDEX).updateDocuments(docs, { primaryKey: "id" });

    logger.info(
      `[MEILI-ORDER-SYNC] ✅ upserted ${docs.length} order doc${
        docs.length === 1 ? "" : "s"
      } (${docs.map((d) => `#${d.display_id}`).join(", ")})`
    );
  } catch (err: any) {
    logger.error(
      `[MEILI-ORDER-SYNC] ❌ sync failed for [${orderIds.join(",")}]: ${
        err?.message
      }`
    );
  }
}

async function deleteOrders(
  orderIds: string[],
  logger: any
): Promise<void> {
  if (orderIds.length === 0) return;
  try {
    const meili = await getMeili();
    await meili.index(ORDERS_INDEX).deleteDocuments(orderIds);
    logger.info(
      `[MEILI-ORDER-SYNC] 🗑️  deleted ${orderIds.length} order doc(s)`
    );
  } catch (err: any) {
    logger.warn(
      `[MEILI-ORDER-SYNC] ⚠️ delete failed for [${orderIds.join(",")}]: ${
        err?.message
      }`
    );
  }
}

async function resolveOrderIdsFromFulfillments(
  fulfillmentIds: string[],
  container: any,
  logger: any
): Promise<string[]> {
  if (fulfillmentIds.length === 0) return [];
  try {
    const query = container.resolve("query");
    const { data } = await query.graph({
      entity: "order",
      fields: ["id"],
      filters: { fulfillments: { id: fulfillmentIds } },
    });
    return (data ?? [])
      .map((o: any) => o?.id)
      .filter((id: unknown): id is string => typeof id === "string" && !!id);
  } catch (err: any) {
    logger.warn(
      `[MEILI-ORDER-SYNC] ⚠️ could not resolve orders for fulfillments [${fulfillmentIds.join(
        ","
      )}]: ${err?.message}`
    );
    return [];
  }
}

async function syncOrdersForCustomer(
  customerId: string,
  container: any,
  logger: any
): Promise<void> {
  try {
    const query = container.resolve("query");
    const { data } = await query.graph({
      entity: "order",
      fields: ["id"],
      filters: { customer_id: customerId },
    });
    const ids = (data ?? [])
      .map((o: any) => o?.id)
      .filter((id: unknown): id is string => typeof id === "string" && !!id);

    if (ids.length === 0) return;

    logger.info(
      `[MEILI-ORDER-SYNC] cascading customer ${customerId} → ${ids.length} order(s)`
    );
    await syncOrders(ids, container, logger);
  } catch (err: any) {
    logger.warn(
      `[MEILI-ORDER-SYNC] ⚠️ customer cascade failed for ${customerId}: ${err?.message}`
    );
  }
}

function extractIds(data: unknown): string[] {
  if (!data) return [];
  if (typeof data === "string") return [data];
  if (Array.isArray(data)) {
    return data
      .map((d) =>
        typeof d === "string" ? d : typeof d?.id === "string" ? d.id : ""
      )
      .filter((s): s is string => !!s);
  }
  if (typeof data === "object") {
    const id = (data as any).id;
    if (typeof id === "string") return [id];
    if (Array.isArray(id))
      return id.filter((s: unknown): s is string => typeof s === "string");
  }
  return [];
}

const DELETE_EVENTS = new Set(["order.archived", "order.deleted"]);
const UPSERT_EVENTS = new Set([
  "order.placed",
  "order.updated",
  "order.canceled",
  "order.payment_captured",
  "order.fulfillment_created",
  "order.customer_transferred",
]);

export default async function orderMeilisearchSubscriber({
  event,
  container,
}: SubscriberArgs<any>) {
  const logger = container.resolve("logger");

  if (event.name === "customer.updated") {
    const customerIds = extractIds(event.data);
    for (const cid of customerIds) {
      await syncOrdersForCustomer(cid, container, logger);
    }
    return;
  }

  // delivery.created carries the FULFILLMENT id, not the order id — resolve
  // the owning order before reindexing.
  if (event.name === "delivery.created") {
    const fulfillmentIds = extractIds(event.data);
    const resolved = await resolveOrderIdsFromFulfillments(
      fulfillmentIds,
      container,
      logger
    );
    await syncOrders(resolved, container, logger);
    return;
  }

  const orderIds = extractIds(event.data);
  if (orderIds.length === 0) {
    logger.warn(
      `[MEILI-ORDER-SYNC] could not extract order ids from ${event.name}`
    );
    return;
  }

  if (DELETE_EVENTS.has(event.name)) {
    await deleteOrders(orderIds, logger);
    return;
  }

  if (UPSERT_EVENTS.has(event.name)) {
    await syncOrders(orderIds, container, logger);
    return;
  }

  logger.warn(`[MEILI-ORDER-SYNC] unhandled event: ${event.name} — ignoring`);
}

export const config: SubscriberConfig = {
  event: [
    "order.placed",
    "order.updated",
    "order.canceled",
    "order.payment_captured",
    "order.fulfillment_created",
    "delivery.created",
    "order.customer_transferred",
    "order.archived",
    "order.deleted",
    "customer.updated",
  ],
};

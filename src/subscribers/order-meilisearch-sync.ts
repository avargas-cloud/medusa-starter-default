import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework";
import { Modules } from "@medusajs/utils";
import { Client } from "pg";

import {
  buildOrderDoc,
  type OrderForMeili,
} from "../lib/meilisearch/build-order-doc";
import { loadFullyInvoicedForOrder } from "../lib/invoices/load-fully-invoiced";
import { enrichOrderFulfillmentsAndItems } from "../lib/meilisearch/enrich-order-fulfillment-items";
import { enrichOrderTotals } from "../lib/meilisearch/enrich-order-totals";

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
 *   • order.archived
 *       → upsert (POS close of a partially-invoiced order archives it; the
 *         doc must land in the Closed tab, not vanish)
 *   • order.deleted
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
  // Line quantities, without which computeFulfillmentStatus cannot demote a
  // fully-delivered fulfillment set to partially_delivered. Missing here until
  // 2026-08-12 while the reindex runner asked for them, so whichever writer
  // touched an order last decided whether it was open: S11417 (10 of 42
  // delivered) indexed as "delivered", dropped out of Open Orders, and was
  // re-typed as a second order that reserved and shipped the same 32 units.
  // SQL below overrides these — they are the fallback if enrichment fails.
  "items.quantity",
  "items.detail.fulfilled_quantity",
];

async function getMeili() {
  const { MeiliSearch } = await import("meilisearch");
  return new MeiliSearch({
    host: process.env.MEILISEARCH_HOST!,
    apiKey: process.env.MEILISEARCH_API_KEY!,
  });
}

/**
 * Rebuilds the Meili doc for specific orders.
 *
 * Exported because the finance routes that move money on an order have to call
 * it directly. Until 2026-07-29 nothing did, and `POST
 * /admin/finance/payments/:id/apply` emitted no event at all, so collecting the
 * balance of an order never rebuilt its doc: `effective_payment` stayed frozen
 * at whatever it was when the order was last indexed. ~900 documents were stale,
 * which is why the Deposited filter returned 960 orders when only 58 actually
 * owed money — #1348, #1350, #1351 and #1353 were paid to the cent and still
 * indexed as deposited.
 *
 * Callers must NOT emit `order.updated` to get this effect instead. That event
 * has other consumers, including the QuickBooks pipeline, and waking it from a
 * payment flow risks enqueueing a non-reversible external operation as a side
 * effect of a freshness fix.
 *
 * The SQL workarounds it depends on now live in src/lib and are shared with the
 * reindex runner (enrichOrderFulfillmentsAndItems / enrichOrderTotals). They used
 * to be a private copy here that asked for less than the runner's, which is how
 * the two writers of this index came to disagree about whether an order was open.
 */
export async function syncOrders(
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

    // Everything query.graph cannot be trusted for, patched from SQL on one
    // connection before the doc is built:
    //
    //   • fulfillments + line quantities — decide fulfillment_status, and
    //     therefore which tab the order lands in. The enrichment is shared with
    //     the reindex runner ON PURPOSE: this subscriber used to ask for less
    //     than the runner did, so an order's tab depended on which of the two
    //     wrote its document last (S11417, 2026-08-12).
    //   • the total — every payment branch in buildOrderDoc is gated on a
    //     positive total, so without it `fully_paid` is unreachable and
    //     everything with money lands in `deposited`.
    //
    // Each enrichment fails independently and non-fatally: indexing a doc with
    // one stale field beats not indexing at all.
    try {
      const db = new Client({ connectionString: process.env.DATABASE_URL });
      await db.connect();
      try {
        try {
          await enrichOrderFulfillmentsAndItems(
            db,
            data as OrderForMeili[],
            orderIds
          );
        } catch (fulErr: any) {
          logger.warn(
            `[MEILI-ORDER-SYNC] fulfillment/item enrichment failed: ${fulErr?.message}`
          );
        }

        try {
          const totals = await enrichOrderTotals(db, data as OrderForMeili[]);
          if (totals.unresolved.length > 0) {
            logger.warn(
              `[MEILI-ORDER-SYNC] no resolvable total for ${totals.unresolved.length} ` +
                `order(s); they index with 0 and land in no payment bucket: ` +
                `${totals.unresolved.slice(0, 10).join(", ")}`
            );
          }
        } catch (totalErr: any) {
          logger.warn(
            `[MEILI-ORDER-SYNC] total enrichment failed: ${totalErr?.message}`
          );
        }
      } finally {
        await db.end();
      }
    } catch (dbErr: any) {
      logger.warn(
        `[MEILI-ORDER-SYNC] SQL enrichment skipped (using query.graph data): ${dbErr?.message}`
      );
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

/**
 * Recomputes the `fully_invoiced` flag for an order and persists it onto
 * order.metadata (merging, never clobbering). Driven by pos.invoice.created /
 * pos.invoice.voided so a separated (layaway) order drops out of the
 * "Separated" tab/badge once it has been completely billed — being fully
 * invoiced means it is no longer an open order, regardless of fulfillment.
 * Also fires on order.updated, covering an order edited down until every
 * remaining line is already billed. The caller reindexes afterward regardless.
 */
async function stampFullyInvoiced(
  orderId: string,
  container: any,
  logger: any
): Promise<void> {
  try {
    const orderModule = container.resolve(Modules.ORDER);
    const order = await orderModule.retrieveOrder(orderId, {
      select: ["id", "metadata"],
    });
    const meta = (order?.metadata ?? {}) as Record<string, unknown>;

    // The flag is ONLY consumed by the Separated derivation (is_separated &&
    // !closed && !fully_invoiced). For non-separated orders it's irrelevant, so
    // skip the invoice load entirely — keeps order.updated cheap (it fires on
    // every edit step). Marking an order separated emits order.updated, so a
    // newly-separated order is still picked up on its next event.
    if (!meta.is_separated) return;

    const fullyInvoiced = await loadFullyInvoicedForOrder(orderId, container);
    if (meta.fully_invoiced === fullyInvoiced) return;

    await orderModule.updateOrders(orderId, {
      metadata: { ...meta, fully_invoiced: fullyInvoiced },
    });
    logger.info(
      `[MEILI-ORDER-SYNC] order ${orderId} fully_invoiced → ${fullyInvoiced}`
    );
  } catch (err: any) {
    // Non-fatal — the reindex still runs with whatever flag is already stored.
    logger.warn(
      `[MEILI-ORDER-SYNC] ⚠️ could not stamp fully_invoiced for ${orderId}: ${err?.message}`
    );
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

const DELETE_EVENTS = new Set(["order.deleted"]);
const UPSERT_EVENTS = new Set([
  "order.placed",
  "order.updated",
  "order.canceled",
  // Archived = the terminal state of a POS "Close Order" on a partially
  // invoiced order (toggle-close branch 3: complete→archive native chain).
  // These orders must LAND in the Closed tab, not vanish from the index —
  // so archived upserts (build-order-doc maps archived → is_closed).
  "order.archived",
  "order.payment_captured",
  "order.fulfillment_created",
  "order.customer_transferred",
  // Native completion (completeOrderWorkflow) flips status pending→completed
  // WITHOUT firing order.updated. Pickup orders complete from complete-pickup,
  // others from invoices/route.ts (Fix B). Both also emit pos.order.fulfilled.
  // Without reindexing here the doc sticks at status='pending' and the POS
  // keeps showing the order in the Open tab.
  "order.completed",
  "pos.order.fulfilled",
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

  // Invoice events carry { order_id } (not the order id in `id`). Recompute
  // and persist the order's fully_invoiced flag, then reindex so the Separated
  // tab/badge drops fully-billed layaway orders.
  if (
    event.name === "pos.invoice.created" ||
    event.name === "pos.invoice.voided"
  ) {
    const orderId =
      typeof event.data?.order_id === "string" ? event.data.order_id : "";
    if (!orderId) {
      logger.warn(
        `[MEILI-ORDER-SYNC] ${event.name} missing order_id — skipping`
      );
      return;
    }
    await stampFullyInvoiced(orderId, container, logger);
    await syncOrders([orderId], container, logger);
    return;
  }

  // delivery.created / shipment.created carry the FULFILLMENT id (not the order
  // id) — resolve the owning order before reindexing. (shipment.created fires
  // when the Tracking button ships a fulfillment; its data.id is the fulfillment.)
  if (event.name === "delivery.created" || event.name === "shipment.created") {
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
    // Recompute fully_invoiced before reindexing. stampFullyInvoiced self-gates
    // on is_separated, so this is a no-op for the vast majority of orders.
    // Covers the "order edited down until nothing's left to dispatch" case:
    // editing quantities fires order.updated (not an invoice event), and the
    // now-smaller line quantities may already be fully covered by prior
    // partial invoices → the order drops out of Separated.
    for (const id of orderIds) {
      await stampFullyInvoiced(id, container, logger);
    }
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
    "order.completed",
    "pos.order.fulfilled",
    // Adding tracking ships a fulfillment (createShipmentWorkflow →
    // "shipment.created"). Its payload carries the FULFILLMENT id (not the order
    // id), so it's resolved like delivery.created below. Without it the order's
    // fulfillment_status change to "shipped" never reindexes (same gap the
    // pickup flow had) → the Tracking button leaves the Meili doc stale.
    "shipment.created",
    "delivery.created",
    "order.customer_transferred",
    "order.archived",
    "order.deleted",
    "customer.updated",
    // Recompute the persisted fully_invoiced flag (drives the Separated tab).
    "pos.invoice.created",
    "pos.invoice.voided",
  ],
};

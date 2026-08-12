import type { Client } from "pg";

import type { OrderForMeili } from "./build-order-doc";

/**
 * Overrides `fulfillments` and current-version line quantities from SQL before
 * the doc is built.
 *
 * Both inputs are unreliable through query.graph: it intermittently returns
 * fulfillments=[] (link race on order_fulfillment) and stale
 * items.detail.fulfilled_quantity. Both feed computeFulfillmentStatus, and both
 * failure directions have shipped:
 *
 *   • missing fulfillments  → a delivered order reads partially_delivered and
 *     is stranded in the Open tab (S10374)
 *   • missing item quantities → a PARTIALLY delivered order reads "delivered",
 *     which flips is_open to false and makes the order vanish from Open Orders
 *     entirely (S11417, 2026-08-11 → someone re-typed the order as S11438 and
 *     the same 32 units got reserved and shipped twice)
 *
 * This lives in one place because it did not, and that is exactly how the two
 * writers of the orders index came to disagree: the reindex runner asked for
 * the line quantities, the event subscriber did not, so whichever wrote last
 * decided whether an order was open. A second copy of this would rot the same
 * way — the whole safety net around this index exists to prevent that.
 *
 * Caller owns the connection (both call sites already open one for
 * enrichOrderTotals) and owns the try/catch: enrichment failing must degrade to
 * query.graph data, never block indexing.
 *
 * @param scopeIds Restrict the SQL to these orders. Omit ONLY for a full
 *   reindex — an unscoped pass re-scans every order_item row, which is why the
 *   per-order callers must always pass their ids.
 */
export async function enrichOrderFulfillmentsAndItems(
  db: Client,
  orders: OrderForMeili[],
  scopeIds?: string[]
): Promise<void> {
  if (orders.length === 0) return;

  const scoped = scopeIds !== undefined;
  const params = scoped ? [scopeIds] : [];

  const [fulRes, itemRes] = await Promise.all([
    db.query<{
      order_id: string;
      packed_at: Date | null;
      shipped_at: Date | null;
      delivered_at: Date | null;
      canceled_at: Date | null;
    }>(
      `SELECT ofu.order_id, f.packed_at, f.shipped_at, f.delivered_at, f.canceled_at
         FROM order_fulfillment ofu
         JOIN fulfillment f ON f.id = ofu.fulfillment_id
        WHERE ofu.deleted_at IS NULL AND f.deleted_at IS NULL
          ${scoped ? "AND ofu.order_id = ANY($1::text[])" : ""}`,
      params
    ),
    db.query<{
      order_id: string;
      quantity: number | string;
      fulfilled_quantity: number | string;
    }>(
      // Current version only: rows from a previous order version carry the
      // quantities from before the edit and would misreport what is still open.
      `SELECT oi.order_id, oi.quantity, oi.fulfilled_quantity
         FROM order_item oi
         JOIN "order" o ON o.id = oi.order_id AND o.version = oi.version
        WHERE oi.deleted_at IS NULL
          ${scoped ? "AND oi.order_id = ANY($1::text[])" : ""}`,
      params
    ),
  ]);

  type Fulfillments = NonNullable<OrderForMeili["fulfillments"]>;
  type Items = NonNullable<OrderForMeili["items"]>;

  const fulByOrder = new Map<string, Fulfillments>();
  for (const r of fulRes.rows) {
    const list = fulByOrder.get(r.order_id) ?? [];
    list.push(r);
    fulByOrder.set(r.order_id, list);
  }

  const itemsByOrder = new Map<string, Items>();
  for (const r of itemRes.rows) {
    const list = itemsByOrder.get(r.order_id) ?? [];
    list.push({
      quantity: r.quantity,
      detail: { fulfilled_quantity: r.fulfilled_quantity },
    });
    itemsByOrder.set(r.order_id, list);
  }

  for (const o of orders) {
    // Authoritative: no rows means the order genuinely has no fulfillments, so
    // an empty list must overwrite whatever query.graph returned.
    o.fulfillments = fulByOrder.get(o.id) ?? [];
    // Items are only overwritten when SQL produced rows — an order with no
    // current-version rows keeps whatever the graph gave, since replacing it
    // with [] would silently drop the hasUnfulfilledItems guard.
    const items = itemsByOrder.get(o.id);
    if (items) o.items = items;
  }
}

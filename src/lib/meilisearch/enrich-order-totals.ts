import type { Client } from "pg";

/**
 * Fills in the order total that `query.graph` does not deliver.
 *
 * `buildOrderDoc`'s getOrderTotal() reads, in order: `metadata.pos_total`,
 * `order.total`, then `order.summary.current_order_total`. ORDER_FIELDS asks for
 * the last two and gets neither — the same class of gap as `payment_status` and
 * `fulfillment_status`, which Medusa computes rather than stores. `pos_total` is
 * absent on 957 orders, so the total came out 0 for most of the index.
 *
 * That single missing input broke both payment buckets, because every branch
 * downstream is gated on a positive total:
 *
 *   - `fully_paid` requires total > 0, so it was UNREACHABLE, and every order
 *     with any money at all fell through to `deposited` — 959 of them, when only
 *     24 actually owe something.
 *   - `is_unpaid` ("owes money", 2026-07-29) also requires total > 0, so it was
 *     inert for those same 959 and the Unpaid tab reported 22 instead of 45.
 *
 * Reindexing did NOT fix it, which is what proved the docs were never stale: the
 * distribution moved by one order. The fix is the input, not the formula, so
 * getOrderTotal is deliberately left alone.
 *
 * Only `summary.current_order_total` is patched — `pos_total` keeps its
 * precedence, because a POS-authored total is the operator's number and outranks
 * anything derived.
 */

type OrderWithSummary = {
  id: string;
  summary?: { current_order_total?: unknown } | null;
};

export type EnrichOrderTotalsResult = {
  /** Orders that had no resolvable total even after the patch. */
  unresolved: string[];
  patched: number;
};

/**
 * Patches `summary.current_order_total` in place for every order missing it.
 *
 * Reads `order_summary` at the order's CURRENT version. A stale-version row
 * carries the total from before an edit, which is exactly the kind of quiet
 * wrongness this whole chain has been about.
 */
export async function enrichOrderTotals(
  db: Client,
  orders: OrderWithSummary[]
): Promise<EnrichOrderTotalsResult> {
  if (orders.length === 0) return { unresolved: [], patched: 0 };

  const missing = orders.filter(
    (order) =>
      order.summary?.current_order_total === undefined ||
      order.summary?.current_order_total === null
  );
  if (missing.length === 0) return { unresolved: [], patched: 0 };

  const res = await db.query<{ order_id: string; total: string | null }>(
    `SELECT s.order_id,
            s.totals->>'current_order_total' AS total
       FROM order_summary s
       JOIN "order" o
         ON o.id = s.order_id
        AND o.version = s.version
      WHERE s.deleted_at IS NULL
        AND s.order_id = ANY($1::text[])`,
    [missing.map((order) => order.id)]
  );

  const totalByOrder = new Map<string, string>();
  for (const row of res.rows) {
    if (row.total !== null) totalByOrder.set(row.order_id, row.total);
  }

  const unresolved: string[] = [];
  let patched = 0;
  for (const order of missing) {
    const total = totalByOrder.get(order.id);
    if (total === undefined) {
      unresolved.push(order.id);
      continue;
    }
    // Money from Postgres arrives as a string — getOrderTotal coerces with
    // asNum, so the raw value is handed over untouched rather than parsed twice.
    order.summary = { ...(order.summary ?? {}), current_order_total: total };
    patched += 1;
  }

  return { unresolved, patched };
}

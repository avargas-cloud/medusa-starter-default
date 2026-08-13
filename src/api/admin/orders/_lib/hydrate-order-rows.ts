import type { MedusaRequest } from "@medusajs/framework/http";
import {
  computeFulfillmentStatus,
  type OrderForMeili,
} from "../../../../lib/meilisearch/build-order-doc";
import { loadSeparationPending } from "./separation-availability";

/**
 * The one projection behind every server-side orders list.
 *
 * It lives here because `/admin/orders/filter` and `/admin/orders/search` are
 * two routes answering about the same order, and they used to answer
 * differently: search hydrated through query.graph, which silently drops
 * `payment_status` and `fulfillment_status` — Medusa computes those instead of
 * storing them, so asking for a computed getter as if it were a column returns
 * nothing and raises no error. The list then rendered an empty FULFILLMENT
 * column, and, worse, the QB REF cell fell through to "Missing in QB" for
 * healthy orders because its fallback reads exactly those two fields
 * (store-pos OrderTableRow.tsx). S11296 — qb_sync_status "synced" — read
 * "Invoiced" on the list and "Missing in QB" the moment you searched for it.
 *
 * Sharing the hydration is the point: two sibling routes cannot disagree about
 * an order if there is only one place that describes one.
 */

// Above this many ids, restricting the aggregate CTEs to the id list costs more
// than it saves. See the measurements in hydrateOrderRows.
const CTE_SCOPE_MAX_IDS = 1000;

/**
 * What the hydration needs to know about an order beyond its id.
 *
 * Only `id` is required. `payment_status` is whatever the caller's source
 * happens to know, which today is nothing in either route — see
 * nativePaymentStatus. `/search` cannot supply it even in principle: the orders
 * index sets displayedAttributes to ["id"], so a search hit carries the id and
 * nothing else regardless of what attributesToRetrieve asks for.
 */
export interface OrderHydrationDoc {
  id: string;
  payment_status?: string;
}

interface OrderListRow {
  id: string;
  display_id: number;
  status: string;
  email: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
  summary: Record<string, unknown> | null;
  customer: Record<string, unknown> | null;
  billing_address: Record<string, unknown> | null;
  sales_channel: Record<string, unknown> | null;
  payment_collections: Array<Record<string, unknown>>;
  shipping_methods: Array<Record<string, unknown>>;
  fulfillments: NonNullable<OrderForMeili["fulfillments"]>;
  items: NonNullable<OrderForMeili["items"]>;
  invoiced_cents: string | number | null;
}

type SqlClient = {
  raw: (
    sql: string,
    bindings?: unknown[]
  ) => Promise<{ rows: unknown[] }>;
};

export type HydratedOrderListRow = Omit<
  OrderListRow,
  "fulfillments" | "items" | "invoiced_cents"
> & {
  payment_status: string;
  fulfillment_status: string;
  total: number | null;
  // Dollars already billed against the order: SUM(pos_invoice.total)/100 over
  // its live invoices (draft and voided excluded). null means no live invoice
  // exists — distinct from 0 only in provenance; both read as "nothing billed".
  // The POS Open-tab footer subtracts this from the order total to show how
  // much remains to be invoiced. Partial invoicing is the norm here (one
  // invoice per dispatch), which is why the boolean fully_invoiced flag is not
  // enough to answer that question.
  invoiced_total: number | null;
  // How many open units are still to be set aside, and how many of those the
  // Miami shelf can back right now. Drives the second slot of the POS Separated
  // column (To Separate / Awaiting Products). Never indexed — see the module
  // note in separation-availability.ts: it derives from live inventory, which
  // no reindex tracks. null when the order contributed no open line.
  separation_pending: { pending: number; available: number } | null;
};

/**
 * Every `order.metadata` key the POS orders list reads.
 *
 * Kept as an exported constant because it is an interface, not an
 * implementation detail: `verify-orders-search-filter-parity.ts` asserts that
 * the keys store-pos reads on the list path are all present here. A key the
 * list reads and this projection omits is invisible — the field simply arrives
 * undefined and the row renders a fallback, which is how `computed_total`, the
 * figure getOrderTotal prefers above all others, went missing for the 1,274
 * orders that carry it without a pos_total.
 */
export const PROJECTED_METADATA_KEYS = [
  "qb_sales_order",
  "qb_invoice",
  "qb_invoices",
  "qb_sync_status",
  "qb_synced_at",
  "qb_sales_order_ref_num",
  "qb_invoice_ref_num",
  "order_placed_at",
  "referential_deposit",
  // Ships WITH referential_deposit, always. The two are halves of one split
  // (deposit = money not yet used, applied_total = money invoices consumed) and
  // getPaidAmount falls back to Medusa's captured amount when applied_total is
  // absent. Sending one without the other is how S11178 displayed Deposit
  // $173.28 AND Paid $173.28 on a $173.28 order: the same dollars twice,
  // because the fallback re-derived what this projection had dropped.
  "applied_total",
  "document_number",
  // The total getOrderTotal reads first (store-pos orders/utils.ts). pos_total
  // is its fallback, not its replacement.
  "computed_total",
  "pos_total",
  "is_separated",
  // Tri-state written by POST /admin/orders/:id/separations (none | partial |
  // full). is_separated stays its boolean mirror (true only on full) so the
  // Separated tab predicate is untouched; this key powers the Partial/Fully
  // badge on the row.
  "separation_status",
  "fully_invoiced",
  "order_status",
  "estimate_status",
  "pos_closed",
  "pos_created",
  "sales_rep",
] as const;

const METADATA_PROJECTION = PROJECTED_METADATA_KEYS.map(
  (key) => `'${key}', o.metadata->'${key}'`
).join(",\n          ");

function resolveSql(req: MedusaRequest): SqlClient {
  return (req.scope as unknown as { resolve: (key: string) => unknown }).resolve(
    "__pg_connection__"
  ) as SqlClient;
}

/**
 * The indexed native payment_status, or "" when the source does not know it.
 *
 * It never does today: Medusa computes payment_status instead of storing it, so
 * query.graph hands the doc builder an empty value and the index carries an
 * empty one. This used to reconstruct "captured" from effective_payment and
 * otherwise assert "not_paid" — asserting a payment state there was no evidence
 * for. "" is the honest answer, and it is safe: the POS reads this field only
 * as a fallback for deriving a paid amount when payment_collections are
 * missing, and both routes always send them.
 */
function nativePaymentStatus(doc: OrderHydrationDoc): string {
  return doc.payment_status || "";
}

/**
 * Projects the orders list view for `docs`, in the order given.
 *
 * The caller owns the ordering — filter sorts by date, search keeps
 * MeiliSearch's relevance — so this preserves the sequence it receives and
 * drops ids with no matching row.
 */
export async function hydrateOrderRows(
  req: MedusaRequest,
  docs: OrderHydrationDoc[]
): Promise<HydratedOrderListRow[]> {
  if (docs.length === 0) return [];

  const ids = docs.map((doc) => doc.id);
  const pg = resolveSql(req);

  // Should the aggregate CTEs below be restricted to `ids`?
  //
  // Postgres is allowed to push a predicate on a grouping key down into a
  // GROUP BY subquery, but measured against production it does not here: with
  // the filter only on the outer SELECT, every request aggregated all 15,883
  // order_item rows no matter how few orders it was serving.
  //
  // Restricting them is a large win while the requested set is a minority of
  // the table, and a loss once it is nearly all of it — at that point testing
  // each row against the id list costs more than scanning. Medians of 3 runs
  // against production (1,272 orders in the table):
  //
  //     ids | unscoped | scoped
  //      24 |   124 ms |  11 ms   (-92%)   Unpaid / Open / Separated
  //     232 |   140 ms |  56 ms   (-58%)   payment filters
  //     954 |   170 ms | 120 ms   (-30%)
  //    1194 |   178 ms | 222 ms   (+25%)   Closed — regression
  //
  // Hence the threshold. It is an empirical break-even at today's table size,
  // not a universal constant: re-measure it if the orders table grows by an
  // order of magnitude. Search always lands far below it — it is capped at 200
  // hits — so only the filter route's whole-tab reads can ever cross it.
  const scopeAggregates = ids.length <= CTE_SCOPE_MAX_IDS;
  // Restricting a CTE cannot change a value this route emits: they are LEFT
  // JOINed on order_id, so rows belonging to orders outside `ids` could never
  // have matched a row inside it. Verified against production by hashing every
  // emitted field of both variants inside one REPEATABLE READ snapshot across
  // all six tabs plus payment and rep filters — identical in every case.
  const scoped = (column: string): string =>
    scopeAggregates ? `AND ${column} = ANY(?::text[])` : "";
  // knex's pg.raw uses positional `?`, so `ids` is bound once per occurrence:
  // five CTEs plus the outer SELECT when scoped, otherwise the outer one alone.
  const bindings = scopeAggregates
    ? [ids, ids, ids, ids, ids, ids]
    : [ids];

  // Availability is its OWN query rather than a sixth CTE, on purpose: the
  // verdict is produced by computeSeparationCaps — the same function the
  // separation modal and the write path use — so the rows have to come back to
  // TypeScript instead of being folded down in SQL. Reimplementing that
  // arithmetic here would let the list and the screen the operator opens next
  // disagree about what is separable. Issued alongside the projection, so it
  // costs the slower of the two rather than the sum.
  const [result, separationPending] = await Promise.all([
    pg.raw(
    `
      WITH payment_agg AS (
        SELECT
          opc.order_id,
          jsonb_agg(
            jsonb_build_object(
              'captured_amount', pc.captured_amount,
              'refunded_amount', pc.refunded_amount
            )
            ORDER BY pc.created_at
          ) AS payment_collections
        FROM order_payment_collection opc
        JOIN payment_collection pc
          ON pc.id = opc.payment_collection_id
         AND pc.deleted_at IS NULL
        WHERE opc.deleted_at IS NULL
          ${scoped("opc.order_id")}
        GROUP BY opc.order_id
      ),
      shipping_agg AS (
        SELECT
          os.order_id,
          jsonb_agg(
            jsonb_build_object(
              'name', osm.name,
              'amount', osm.amount
            )
            ORDER BY osm.created_at
          ) AS shipping_methods
        FROM order_shipping os
        JOIN "order" current_order
          ON current_order.id = os.order_id
         AND current_order.version = os.version
         AND current_order.deleted_at IS NULL
        JOIN order_shipping_method osm
          ON osm.id = os.shipping_method_id
         AND osm.deleted_at IS NULL
        WHERE os.deleted_at IS NULL
          ${scoped("os.order_id")}
        GROUP BY os.order_id
      ),
      fulfillment_agg AS (
        SELECT
          order_fulfillment.order_id,
          jsonb_agg(jsonb_build_object(
            'packed_at', fulfillment.packed_at,
            'shipped_at', fulfillment.shipped_at,
            'delivered_at', fulfillment.delivered_at,
            'canceled_at', fulfillment.canceled_at
          ) ORDER BY order_fulfillment.id) AS fulfillments
        FROM order_fulfillment
        JOIN fulfillment
          ON fulfillment.id = order_fulfillment.fulfillment_id
         AND fulfillment.deleted_at IS NULL
        WHERE order_fulfillment.deleted_at IS NULL
          ${scoped("order_fulfillment.order_id")}
        GROUP BY order_fulfillment.order_id
      ),
      item_agg AS (
        SELECT
          order_item.order_id,
          jsonb_agg(jsonb_build_object(
            'quantity', order_item.quantity,
            'detail', jsonb_build_object(
              'fulfilled_quantity', order_item.fulfilled_quantity
            )
          ) ORDER BY order_item.id) AS items
        FROM order_item
        JOIN "order" current_order
          ON current_order.id = order_item.order_id
         AND current_order.version = order_item.version
         AND current_order.deleted_at IS NULL
        WHERE order_item.deleted_at IS NULL
          ${scoped("order_item.order_id")}
        GROUP BY order_item.order_id
      ),
      invoice_agg AS (
        SELECT
          pos_invoice.order_id,
          SUM(pos_invoice.total) AS invoiced_cents
        FROM pos_invoice
        WHERE pos_invoice.deleted_at IS NULL
          AND pos_invoice.status NOT IN ('draft', 'voided')
          ${scoped("pos_invoice.order_id")}
        GROUP BY pos_invoice.order_id
      )
      SELECT
        o.id,
        o.display_id,
        o.status,
        o.email,
        jsonb_strip_nulls(jsonb_build_object(
          ${METADATA_PROJECTION}
        )) AS metadata,
        o.created_at,
        CASE WHEN summary.totals IS NULL THEN NULL ELSE jsonb_build_object(
          'current_order_total', summary.totals->'current_order_total',
          'original_order_total', summary.totals->'original_order_total',
          'paid_total', summary.totals->'paid_total',
          'pending_difference', summary.totals->'pending_difference'
        ) END AS summary,
        CASE WHEN c.id IS NULL THEN NULL ELSE jsonb_build_object(
          'first_name', c.first_name,
          'last_name', c.last_name,
          'email', c.email,
          'phone', c.phone,
          'company_name', c.company_name
        ) END AS customer,
        CASE WHEN ba.id IS NULL THEN NULL ELSE jsonb_build_object(
          'company', ba.company
        ) END AS billing_address,
        CASE WHEN sc.id IS NULL THEN NULL ELSE jsonb_build_object(
          'id', sc.id,
          'name', sc.name
        ) END AS sales_channel,
        COALESCE(pa.payment_collections, '[]'::jsonb) AS payment_collections,
        COALESCE(sa.shipping_methods, '[]'::jsonb) AS shipping_methods,
        COALESCE(fa.fulfillments, '[]'::jsonb) AS fulfillments,
        COALESCE(ia.items, '[]'::jsonb) AS items,
        inva.invoiced_cents AS invoiced_cents
      FROM "order" o
      LEFT JOIN customer c
        ON c.id = o.customer_id
       AND c.deleted_at IS NULL
      LEFT JOIN order_address ba
        ON ba.id = o.billing_address_id
       AND ba.deleted_at IS NULL
      LEFT JOIN sales_channel sc
        ON sc.id = o.sales_channel_id
       AND sc.deleted_at IS NULL
      LEFT JOIN order_summary summary
        ON summary.order_id = o.id
       AND summary.version = o.version
       AND summary.deleted_at IS NULL
      LEFT JOIN payment_agg pa ON pa.order_id = o.id
      LEFT JOIN shipping_agg sa ON sa.order_id = o.id
      LEFT JOIN fulfillment_agg fa ON fa.order_id = o.id
      LEFT JOIN item_agg ia ON ia.order_id = o.id
      LEFT JOIN invoice_agg inva ON inva.order_id = o.id
      WHERE o.deleted_at IS NULL
        AND o.id = ANY(?::text[])
    `,
      bindings
    ),
    loadSeparationPending(pg, ids),
  ]);

  const rows = result.rows as OrderListRow[];
  const rowsById = new Map(rows.map((row) => [row.id, row]));

  return docs.flatMap((doc) => {
    const row = rowsById.get(doc.id);
    if (!row) return [];
    const { fulfillments, items, invoiced_cents, ...listRow } = row;

    const summaryTotal = row.summary?.current_order_total;
    const numericSummaryTotal =
      typeof summaryTotal === "number"
        ? summaryTotal
        : typeof summaryTotal === "string"
          ? Number(summaryTotal)
          : null;

    // pg hands SUM(numeric) back as a string; pos_invoice money is in cents.
    const numericInvoicedCents =
      invoiced_cents != null ? Number(invoiced_cents) : null;

    return [{
      ...listRow,
      payment_status: nativePaymentStatus(doc),
      // The whole reason this module exists. Medusa computes this instead of
      // storing it, so it has to be derived from the fulfillment and item rows
      // the CTEs above collected.
      fulfillment_status: computeFulfillmentStatus(fulfillments, items),
      total:
        numericSummaryTotal !== null && Number.isFinite(numericSummaryTotal)
          ? numericSummaryTotal
          : null,
      invoiced_total:
        numericInvoicedCents !== null && Number.isFinite(numericInvoicedCents)
          ? numericInvoicedCents / 100
          : null,
      separation_pending: separationPending.get(doc.id) ?? null,
    }];
  });
}

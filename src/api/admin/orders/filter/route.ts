import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import {
  computeFulfillmentStatus,
  type OrderForMeili,
} from "../../../../lib/meilisearch/build-order-doc";
import { parseRep, repFilter } from "../_lib/rep-filter";

/**
 * GET /admin/orders/filter?tab=<tab>&payment=<effective>
 *
 * MeiliSearch owns the exact membership of each derived tab. PostgreSQL then
 * supplies a compact list projection in one query. This avoids query.graph's
 * deep relationship hydration, which took several seconds for the Closed tab.
 */

const ORDERS_INDEX = "orders";
const PAGE = 1000;
const MAX_TOTAL = 10000;

// Above this many ids, restricting the aggregate CTEs to the id list costs more
// than it saves. See the measurements in hydrateOrderRows.
const CTE_SCOPE_MAX_IDS = 1000;

const TAB_FILTER: Record<string, string> = {
  unpaid: "is_unpaid = true",
  open: "is_open = true",
  closed: "is_closed = true",
  web: "is_web = true",
  separated: "is_separated = true",
  // Orders the POS presents as finished that Medusa never closed: the operator
  // sees them delivered/shipped, but order.status is still pending, so
  // completeOrderWorkflow either never ran or one of its four guards blocked it
  // (pending + everything fulfilled + paid in full + no draft credit memo).
  // An exception queue, not a view of "closed" orders — listing every natively
  // closed order would repeat the Closed tab almost row for row (1,178 of
  // 1,196). Admin-only in the POS.
  medusa_open: 'is_closed = true AND status != "completed" AND status != "archived"',
};

// `captured` was dropped on 2026-07-29 — see the note on EffectivePaymentStatus
// in build-order-doc. Accepting it here would be accepting a filter that can
// only ever return nothing.
const VALID_PAYMENTS = new Set([
  "not_paid",
  "deposited",
  "fully_paid",
  "voided",
]);

type EffectivePayment = "not_paid" | "deposited" | "fully_paid" | "voided";

interface MeiliOrderListDoc {
  id: string;
  payment_status: string;
  effective_payment: EffectivePayment;
  created_at_ts: number;
}

const MEILI_FIELDS: Array<keyof MeiliOrderListDoc> = [
  "id",
  "payment_status",
  "effective_payment",
  "created_at_ts",
];

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
}

type SqlClient = {
  raw: (
    sql: string,
    bindings?: unknown[]
  ) => Promise<{ rows: unknown[] }>;
};

type HydratedOrderListRow = Omit<OrderListRow, "fulfillments" | "items"> & {
  payment_status: string;
  fulfillment_status: string;
  total: number | null;
};

function resolveSql(req: MedusaRequest): SqlClient {
  return (req.scope as unknown as { resolve: (key: string) => unknown }).resolve(
    "__pg_connection__"
  ) as SqlClient;
}

function parseTs(value: unknown): number | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * The indexed native payment_status, or "" when the index does not know it.
 *
 * It never does today: Medusa computes payment_status instead of storing it, so
 * query.graph hands the doc builder an empty value. This used to reconstruct
 * "captured" from effective_payment and otherwise assert "not_paid" — asserting
 * a payment state the index had no evidence for. "" is the honest answer, and
 * it is safe: the POS reads this field only as a fallback for deriving a paid
 * amount when payment_collections are missing, and this route always sends
 * them.
 */
function nativePaymentStatus(doc: MeiliOrderListDoc): string {
  return doc.payment_status || "";
}

async function hydrateOrderRows(
  req: MedusaRequest,
  docs: MeiliOrderListDoc[]
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
  // order of magnitude. Once this route serves one page at a time rather than a
  // whole tab, every request lands far below it and the branch stops mattering.
  const scopeAggregates = ids.length <= CTE_SCOPE_MAX_IDS;
  // Restricting a CTE cannot change a value this route emits: they are LEFT
  // JOINed on order_id, so rows belonging to orders outside `ids` could never
  // have matched a row inside it. Verified against production by hashing every
  // emitted field of both variants inside one REPEATABLE READ snapshot across
  // all six tabs plus payment and rep filters — identical in every case.
  const scoped = (column: string): string =>
    scopeAggregates ? `AND ${column} = ANY(?::text[])` : "";
  // knex's pg.raw uses positional `?`, so `ids` is bound once per occurrence:
  // four CTEs plus the outer SELECT when scoped, otherwise the outer one alone.
  const bindings = scopeAggregates
    ? [ids, ids, ids, ids, ids]
    : [ids];

  const result = await pg.raw(
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
      )
      SELECT
        o.id,
        o.display_id,
        o.status,
        o.email,
        jsonb_strip_nulls(jsonb_build_object(
          'qb_sales_order', o.metadata->'qb_sales_order',
          'qb_invoice', o.metadata->'qb_invoice',
          'qb_invoices', o.metadata->'qb_invoices',
          'qb_sync_status', o.metadata->'qb_sync_status',
          'qb_synced_at', o.metadata->'qb_synced_at',
          'qb_sales_order_ref_num', o.metadata->'qb_sales_order_ref_num',
          'qb_invoice_ref_num', o.metadata->'qb_invoice_ref_num',
          'order_placed_at', o.metadata->'order_placed_at',
          'referential_deposit', o.metadata->'referential_deposit',
          'document_number', o.metadata->'document_number',
          'pos_total', o.metadata->'pos_total',
          'is_separated', o.metadata->'is_separated',
          'fully_invoiced', o.metadata->'fully_invoiced',
          'order_status', o.metadata->'order_status',
          'estimate_status', o.metadata->'estimate_status',
          'pos_closed', o.metadata->'pos_closed',
          'pos_created', o.metadata->'pos_created',
          'sales_rep', o.metadata->'sales_rep'
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
        COALESCE(ia.items, '[]'::jsonb) AS items
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
      WHERE o.deleted_at IS NULL
        AND o.id = ANY(?::text[])
    `,
    bindings
  );

  const rows = result.rows as OrderListRow[];
  const rowsById = new Map(rows.map((row) => [row.id, row]));

  return docs.flatMap((doc) => {
    const row = rowsById.get(doc.id);
    if (!row) return [];
    const { fulfillments, items, ...listRow } = row;

    const summaryTotal = row.summary?.current_order_total;
    const numericSummaryTotal =
      typeof summaryTotal === "number"
        ? summaryTotal
        : typeof summaryTotal === "string"
          ? Number(summaryTotal)
          : null;

    return [{
      ...listRow,
      payment_status: nativePaymentStatus(doc),
      fulfillment_status: computeFulfillmentStatus(fulfillments, items),
      total:
        numericSummaryTotal !== null && Number.isFinite(numericSummaryTotal)
          ? numericSummaryTotal
          : null,
    }];
  });
}

export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
  const tab = (req.query.tab as string | undefined)?.trim();
  const payment = (req.query.payment as string | undefined)?.trim();
  const from = parseTs(req.query.from);
  const to = parseTs(req.query.to);
  const showCancelled = req.query.showCancelled === "true";
  const rep = parseRep(req.query.rep);
  const repName = parseRep(req.query.rep_name);

  const filters: string[] = ["is_draft = false", ...repFilter(rep, repName)];
  if (tab && TAB_FILTER[tab]) filters.push(TAB_FILTER[tab]);
  if (payment && VALID_PAYMENTS.has(payment)) {
    filters.push(`effective_payment = "${payment}"`);
  }
  if (from !== null) filters.push(`effective_date_ts >= ${from}`);
  if (to !== null) filters.push(`effective_date_ts <= ${to}`);
  if (!showCancelled) {
    filters.push("is_canceled = false", "is_voided = false");
  }

  // A rep selection alone is enough to need this route: on the All tab there is
  // no other server-side filter, and falling through to the base-200 feed is
  // precisely what made rep JTV look like it had no orders.
  const hasRepFilter = rep !== null || repName !== null;
  if (!tab && !payment && !hasRepFilter) {
    return res.json({ orders: [], estimatedTotalHits: 0 });
  }

  try {
    const { MeiliSearch } = await import("meilisearch");
    const meili = new MeiliSearch({
      host: process.env.MEILISEARCH_HOST!,
      apiKey: process.env.MEILISEARCH_API_KEY!,
    });
    const index = meili.index(ORDERS_INDEX);

    const docs: MeiliOrderListDoc[] = [];
    let estimatedTotalHits = 0;

    for (let offset = 0; offset < MAX_TOTAL; offset += PAGE) {
      const page = await index.getDocuments<MeiliOrderListDoc>({
        filter: filters,
        fields: MEILI_FIELDS,
        limit: PAGE,
        offset,
      });
      estimatedTotalHits = page.total;
      docs.push(...page.results);
      if (page.results.length < PAGE) break;
    }

    docs.sort((a, b) => b.created_at_ts - a.created_at_ts);
    const orders = await hydrateOrderRows(req, docs);
    return res.json({ orders, estimatedTotalHits });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown filter error";
    return res.status(500).json({
      error: "filter_failed",
      message,
      orders: [],
    });
  }
};

export const AUTHENTICATE = ["user"];

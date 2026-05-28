import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { computeFulfillmentStatus } from "../../../../lib/meilisearch/build-order-doc";

/**
 * GET /admin/orders/filter?tab=<tab>&payment=<effective>&limit=<n>
 *
 * Server-side tab/payment filtering across the ENTIRE orders database via
 * MeiliSearch. The POS /orders page only loads the 200 most-recent orders
 * for its idle feed; the native Medusa `/admin/orders` endpoint does NOT
 * support filtering by payment/fulfillment status (those are computed fields,
 * silently stripped from the query), so a tab could never reach orders
 * outside that 200-window. This endpoint fixes that: Meili holds derived
 * flags (is_unpaid, is_open, is_closed, is_separated, is_web,
 * effective_payment) computed identically to the POS UI helpers, so a filter
 * returns the true full set regardless of recency.
 *
 * Returns the same `{ orders: [...] }` shape as `/admin/orders` so the
 * frontend can merge it transparently.
 *
 *   tab     — one of: unpaid | open | closed | web | separated  (optional)
 *   payment — effective payment status: not_paid | deposited |
 *             fully_paid | captured | voided                    (optional)
 *
 * Cancelled/voided orders are NOT pre-excluded here — the frontend already
 * hides them unless "show cancelled" is on, so leaving them in keeps the
 * client filter authoritative and matches existing behavior exactly.
 */

const ORDERS_INDEX = "orders";

const HYDRATE_FIELDS = [
  "id",
  "display_id",
  "status",
  "payment_status",
  "fulfillment_status",
  "total",
  "created_at",
  "email",
  "metadata",
  "summary.*",
  "customer.first_name",
  "customer.last_name",
  "customer.email",
  "customer.phone",
  "customer.company_name",
  "billing_address.company",
  "sales_channel.id",
  "sales_channel.name",
  "payment_collections.captured_amount",
  "payment_collections.refunded_amount",
  "shipping_methods.name",
  "shipping_methods.amount",
  "shipping_methods.tax_total",
  // Needed so we can compute fulfillment_status server-side before
  // returning — query.graph silently drops the top-level field, so the
  // hydrated rows ship to the client with fulfillment_status missing and
  // every UI predicate (isOpen / isClosed) evaluates false.
  "fulfillments.packed_at",
  "fulfillments.shipped_at",
  "fulfillments.delivered_at",
  "fulfillments.canceled_at",
];

const TAB_FILTER: Record<string, string> = {
  unpaid: "is_unpaid = true",
  open: "is_open = true",
  closed: "is_closed = true",
  web: "is_web = true",
  separated: "is_separated = true",
};

const VALID_PAYMENTS = new Set([
  "not_paid",
  "deposited",
  "fully_paid",
  "captured",
  "voided",
]);

// Meili caps a single search at maxTotalHits (default 1000); page through
// to stay correct even if the order count grows past that.
const PAGE = 1000;
const MAX_TOTAL = 10000;

export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
  const tab = (req.query.tab as string | undefined)?.trim();
  const payment = (req.query.payment as string | undefined)?.trim();

  // Exclude POS estimates via the canonical is_draft_order boolean (is_draft).
  // status != "draft" was fragile — canceled estimates keep is_draft_order=true
  // but status="canceled", so they slipped past the string check.
  const filters: string[] = ["is_draft = false"];
  if (tab && TAB_FILTER[tab]) filters.push(TAB_FILTER[tab]);
  if (payment && VALID_PAYMENTS.has(payment)) {
    filters.push(`effective_payment = "${payment}"`);
  }

  // Nothing to filter on → return empty (the base feed already covers "all").
  if (filters.length === 1) {
    return res.json({ orders: [], estimatedTotalHits: 0 });
  }

  try {
    const { MeiliSearch } = await import("meilisearch");
    const meili = new MeiliSearch({
      host: process.env.MEILISEARCH_HOST!,
      apiKey: process.env.MEILISEARCH_API_KEY!,
    });
    const index = meili.index(ORDERS_INDEX);

    const ids: string[] = [];
    let offset = 0;
    let estimatedTotalHits = 0;
    for (let guard = 0; guard < MAX_TOTAL / PAGE + 1; guard++) {
      const meiliRes = await index.search("", {
        filter: filters,
        limit: PAGE,
        offset,
        attributesToRetrieve: ["id"],
        sort: ["created_at_ts:desc"],
      });
      estimatedTotalHits = meiliRes.estimatedTotalHits ?? ids.length;
      const pageIds = meiliRes.hits
        .map((h: any) => h?.id)
        .filter((id: unknown): id is string => typeof id === "string" && !!id);
      ids.push(...pageIds);
      if (pageIds.length < PAGE || ids.length >= MAX_TOTAL) break;
      offset += PAGE;
    }

    if (ids.length === 0) {
      return res.json({ orders: [], estimatedTotalHits });
    }

    const query = (req.scope as any).resolve("query");
    const { data: hydrated } = await query.graph({
      entity: "order",
      fields: HYDRATE_FIELDS,
      filters: { id: ids },
    });

    // Stamp fulfillment_status onto each row using the same compute that the
    // Meili indexer uses. query.graph drops the top-level fulfillment_status,
    // so without this the client sees `undefined` and isOpen/isClosed both
    // return false — orders pulled in by the tab filter would be invisible.
    const enriched = (hydrated || []).map((o: Record<string, unknown>) => ({
      ...o,
      fulfillment_status:
        (o.fulfillment_status as string | undefined) ||
        computeFulfillmentStatus(
          o.fulfillments as Parameters<typeof computeFulfillmentStatus>[0]
        ),
    }));

    return res.json({
      orders: enriched,
      estimatedTotalHits,
    });
  } catch (err: any) {
    return res.status(500).json({
      error: "filter_failed",
      message: err?.message || "Unknown error",
      orders: [],
    });
  }
};

export const AUTHENTICATE = ["user"];

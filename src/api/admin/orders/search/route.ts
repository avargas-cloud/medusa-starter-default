import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

/**
 * GET /admin/orders/search?q=<term>
 *
 * Server-side full-text search across the entire orders database via
 * MeiliSearch (typo-tolerant, fuzzy). Used by the POS /orders search bar
 * when the user types a query — covers fields the SQL `?q=` cannot:
 *   • metadata.document_number  (e.g. "S10090")
 *   • customer name / email / phone
 *   • company name
 *   • QB SO/Invoice ref numbers
 *
 * Returns the same `{ orders: [...] }` shape as `/admin/orders` so the
 * frontend can swap data sources transparently. Hits are hydrated from
 * Medusa with the standard FIELDS the orders list view needs.
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
];

export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
  const q = (req.query.q as string | undefined)?.trim() ?? "";
  const limit = Math.min(
    Number(req.query.limit ?? 50) || 50,
    200
  );

  if (!q) {
    return res.json({
      orders: [],
      query: "",
      processingTimeMs: 0,
      estimatedTotalHits: 0,
    });
  }

  try {
    const { MeiliSearch } = await import("meilisearch");
    const meili = new MeiliSearch({
      host: process.env.MEILISEARCH_HOST!,
      apiKey: process.env.MEILISEARCH_API_KEY!,
    });

    // If the user typed something phone-shaped (≥7 digits when stripped),
    // also strip non-digits and search the digits-only variant. Phones in
    // the DB are stored as "(305) 851-7028" or "555-9112"; tokenizing
    // splits them, so a hyphenated query matches noisily. The
    // `customer_phone_digits` field stores the digits-only form for clean
    // exact-token matches.
    const digits = q.replace(/\D/g, "");
    const searchTerm =
      digits.length >= 7 && digits.length !== q.length ? digits : q;

    const meiliRes = await meili.index(ORDERS_INDEX).search(searchTerm, {
      limit,
      attributesToRetrieve: ["id", "display_id"],
      sort: ["created_at_ts:desc"],
      filter: "is_draft = false",
    });

    const ids: string[] = meiliRes.hits
      .map((h: any) => h?.id)
      .filter((id: unknown): id is string => typeof id === "string" && !!id);

    if (ids.length === 0) {
      return res.json({
        orders: [],
        query: meiliRes.query,
        processingTimeMs: meiliRes.processingTimeMs,
        estimatedTotalHits: meiliRes.estimatedTotalHits,
      });
    }

    const query = (req.scope as any).resolve("query");
    const { data: hydrated } = await query.graph({
      entity: "order",
      fields: HYDRATE_FIELDS,
      filters: { id: ids },
    });

    // Preserve Meili's relevance ordering instead of Medusa's.
    const byId = new Map<string, any>();
    for (const o of hydrated || []) {
      if (o?.id) byId.set(o.id, o);
    }
    const ordered = ids.map((id) => byId.get(id)).filter(Boolean);

    return res.json({
      orders: ordered,
      query: meiliRes.query,
      processingTimeMs: meiliRes.processingTimeMs,
      estimatedTotalHits: meiliRes.estimatedTotalHits,
    });
  } catch (err: any) {
    return res.status(500).json({
      error: "search_failed",
      message: err?.message || "Unknown error",
      orders: [],
    });
  }
};

export const AUTHENTICATE = ["user"];

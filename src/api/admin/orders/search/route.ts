import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { hydrateOrderRows } from "../_lib/hydrate-order-rows";

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
 * MeiliSearch decides WHICH orders match; the shared projection in
 * _lib/hydrate-order-rows says what each one IS. Returns the same
 * `{ orders: [...] }` shape as /admin/orders/filter, which is the point: the
 * POS swaps between the two by tab, and until 2026-07-31 they disagreed. This
 * route hydrated through query.graph asking for `payment_status` and
 * `fulfillment_status`, which Medusa computes rather than stores — query.graph
 * returns neither and raises nothing — so searching blanked the FULFILLMENT
 * column and pushed healthy orders into "Missing in QB", whose fallback reads
 * exactly those two fields.
 */

const ORDERS_INDEX = "orders";

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
      // The index sets displayedAttributes to ["id"], so a hit carries the id
      // and nothing else no matter what is asked for here. Asking for more is
      // not an error — it is silently ignored, which is why this used to
      // request a `display_id` that never once arrived.
      attributesToRetrieve: ["id"],
      sort: ["created_at_ts:desc"],
      filter: "is_draft = false",
    });

    const ids: string[] = meiliRes.hits
      .map((h: unknown) => (h as { id?: unknown })?.id)
      .filter((id: unknown): id is string => typeof id === "string" && !!id);

    if (ids.length === 0) {
      return res.json({
        orders: [],
        query: meiliRes.query,
        processingTimeMs: meiliRes.processingTimeMs,
        estimatedTotalHits: meiliRes.estimatedTotalHits,
      });
    }

    // Hydrated in MeiliSearch's order, which is relevance rather than date —
    // hydrateOrderRows preserves the sequence it is handed.
    const orders = await hydrateOrderRows(
      req,
      ids.map((id) => ({ id }))
    );

    return res.json({
      orders,
      query: meiliRes.query,
      processingTimeMs: meiliRes.processingTimeMs,
      estimatedTotalHits: meiliRes.estimatedTotalHits,
    });
  } catch (err: unknown) {
    return res.status(500).json({
      error: "search_failed",
      message: err instanceof Error ? err.message : "Unknown error",
      orders: [],
    });
  }
};

export const AUTHENTICATE = ["user"];

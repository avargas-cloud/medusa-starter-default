import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { parseRep, repFilter } from "../_lib/rep-filter";

/**
 * GET /admin/orders/counts?from=<ms>&to=<ms>&showCancelled=true|false
 *                         &rep=<initials>&rep_name=<name>
 *
 * Returns the REAL tab counts for the POS /orders page, computed off the
 * MeiliSearch `orders` index across the entire DB. Previously the page
 * loaded the 200 most-recent orders and counted in memory, so the tab badges
 * lied for any tab whose true population extended past that window.
 *
 *   from / to       — effective-date timestamps (ms). Mirrors the
 *                     UI date-range filter (metadata.order_placed_at fallback
 *                     to created_at — see effective_date_ts on the doc).
 *   showCancelled   — when "true", cancelled/voided orders count toward each
 *                     tab. Default false (matches the UI default).
 *   rep / rep_name  — sales-rep filter. Both are matched against the single
 *                     `sales_rep_initials` field because the source metadata
 *                     is inconsistent (object with initials, or a bare
 *                     string) — mirrors the POS predicate exactly. Omit for
 *                     "All". The badges MUST honour this: the footer counts
 *                     the rep-filtered rows, so a badge that ignored the rep
 *                     would disagree with the table it labels.
 *
 * Response:
 *   {
 *     counts: { all, open, closed, unpaid, web, separated },
 *     cancelledCount: number
 *   }
 *
 * Seven document-fetch calls run in parallel with limit=0, reading the exact
 * `total`. They deliberately do NOT use index.search()/estimatedTotalHits:
 * Meili clamps that value to pagination.maxTotalHits (default 1000), which is
 * why the All and Closed badges sat frozen at exactly 1000 while the real
 * populations were 1210 and 1193. The documents endpoint has no such cap.
 */

const ORDERS_INDEX = "orders";

export type OrdersCountsResponse = {
  counts: {
    all: number;
    open: number;
    closed: number;
    unpaid: number;
    web: number;
    separated: number;
    /** POS-closed but never closed natively in Medusa. Admin-only tab. */
    medusa_open: number;
  };
  cancelledCount: number;
};

function parseTs(v: unknown): number | null {
  if (typeof v !== "string" || v.length === 0) return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Mirrors the UI's getEffectiveDate() (metadata.order_placed_at fallback to
// created_at). Backfilled via sync-meili-orders on 2026-05-25; the subscriber
// keeps it fresh on every order event from here on.
function dateFilters(from: number | null, to: number | null): string[] {
  const out: string[] = [];
  if (from !== null) out.push(`effective_date_ts >= ${from}`);
  if (to !== null) out.push(`effective_date_ts <= ${to}`);
  return out;
}


export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
  const from = parseTs(req.query.from);
  const to = parseTs(req.query.to);
  const showCancelled = req.query.showCancelled === "true";
  const rep = parseRep(req.query.rep);
  const repName = parseRep(req.query.rep_name);

  try {
    const { MeiliSearch } = await import("meilisearch");
    const meili = new MeiliSearch({
      host: process.env.MEILISEARCH_HOST!,
      apiKey: process.env.MEILISEARCH_API_KEY!,
    });
    const index = meili.index(ORDERS_INDEX);

    const dateF = dateFilters(from, to);
    // Exclude POS estimates: key off the canonical is_draft_order boolean
    // (is_draft), not status != "draft" — a draft order's status can drift
    // (e.g. canceled estimates keep is_draft_order=true but status="canceled").
    const baseFilters: string[] = [
      "is_draft = false",
      ...dateF,
      ...repFilter(rep, repName),
    ];

    // Tab counts honor showCancelled: when off, exclude is_canceled/is_voided.
    const tabBase = showCancelled
      ? baseFilters
      : [...baseFilters, "is_canceled = false", "is_voided = false"];

    // EXACT count. index.search()'s estimatedTotalHits is clamped to
    // pagination.maxTotalHits; the documents endpoint's `total` is not, so this
    // is the only shape that can report a population above that ceiling.
    const countExact = async (filters: string[]): Promise<number> => {
      const r = await index.getDocuments<{ id: string }>({
        filter: filters,
        fields: ["id"],
        limit: 0,
      });
      return r.total ?? 0;
    };

    const [all, open, closed, unpaid, web, separated, medusaOpen, cancelledCount] =
      await Promise.all([
        countExact(tabBase),
        countExact([...tabBase, "is_open = true"]),
        countExact([...tabBase, "is_closed = true"]),
        countExact([...tabBase, "is_unpaid = true"]),
        countExact([...tabBase, "is_web = true"]),
        countExact([...tabBase, "is_separated = true"]),
        // Must mirror TAB_FILTER.medusa_open in the filter route exactly, or the
        // badge and the table it labels disagree.
        countExact([
          ...tabBase,
          'is_closed = true AND status != "completed" AND status != "archived"',
        ]),
        // Cancelled chip count: independent of showCancelled, always reflects
        // the date-range slice of cancelled + voided orders.
        countExact([
          ...baseFilters,
          "(is_canceled = true OR is_voided = true)",
        ]),
      ]);

    const body: OrdersCountsResponse = {
      counts: { all, open, closed, unpaid, web, separated, medusa_open: medusaOpen },
      cancelledCount,
    };
    return res.json(body);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return res.status(500).json({ error: "counts_failed", message });
  }
};

export const AUTHENTICATE = ["user"];

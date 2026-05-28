import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

/**
 * GET /admin/orders/counts?from=<ms>&to=<ms>&showCancelled=true|false
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
 *
 * Response:
 *   {
 *     counts: { all, open, closed, unpaid, web, separated },
 *     cancelledCount: number
 *   }
 *
 * Six Meili searches run in parallel with limit=0; only estimatedTotalHits
 * is read, so each request is ~tens of ms.
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
    const baseFilters: string[] = ["is_draft = false", ...dateF];

    // Tab counts honor showCancelled: when off, exclude is_canceled/is_voided.
    const tabBase = showCancelled
      ? baseFilters
      : [...baseFilters, "is_canceled = false", "is_voided = false"];

    const search = async (filters: string[]): Promise<number> => {
      const r = await index.search("", {
        filter: filters,
        limit: 0,
      });
      return r.estimatedTotalHits ?? 0;
    };

    const [all, open, closed, unpaid, web, separated, cancelledCount] =
      await Promise.all([
        search(tabBase),
        search([...tabBase, "is_open = true"]),
        search([...tabBase, "is_closed = true"]),
        search([...tabBase, "is_unpaid = true"]),
        search([...tabBase, "is_web = true"]),
        search([...tabBase, "is_separated = true"]),
        // Cancelled chip count: independent of showCancelled, always reflects
        // the date-range slice of cancelled + voided orders.
        search([
          ...baseFilters,
          "(is_canceled = true OR is_voided = true)",
        ]),
      ]);

    const body: OrdersCountsResponse = {
      counts: { all, open, closed, unpaid, web, separated },
      cancelledCount,
    };
    return res.json(body);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return res.status(500).json({ error: "counts_failed", message });
  }
};

export const AUTHENTICATE = ["user"];

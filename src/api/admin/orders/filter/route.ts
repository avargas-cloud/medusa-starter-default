import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { hydrateOrderRows } from "../_lib/hydrate-order-rows";
import { parseRep, repFilter } from "../_lib/rep-filter";
import { SEPARATED_TAB_FILTER } from "../_lib/separation-status";

/**
 * GET /admin/orders/filter?tab=<tab>&payment=<effective>
 *
 * MeiliSearch owns the exact membership of each derived tab. PostgreSQL then
 * supplies a compact list projection in one query. This avoids query.graph's
 * deep relationship hydration, which took several seconds for the Closed tab.
 *
 * The projection itself lives in _lib/hydrate-order-rows so that this route and
 * /admin/orders/search cannot describe the same order differently.
 */

const ORDERS_INDEX = "orders";
const PAGE = 1000;
const MAX_TOTAL = 10000;

const TAB_FILTER: Record<string, string> = {
  unpaid: "is_unpaid = true",
  open: "is_open = true",
  closed: "is_closed = true",
  web: "is_web = true",
  separated: SEPARATED_TAB_FILTER,
  // Orders the POS presents as finished that Medusa never closed: the operator
  // sees them delivered/shipped, but order.status is still pending, so
  // completeOrderWorkflow either never ran or one of its four guards blocked it
  // (pending + everything fulfilled + paid in full + no draft credit memo).
  // An exception queue, not a view of "closed" orders — listing every natively
  // closed order would repeat the Closed tab almost row for row (1,178 of
  // 1,196). Admin-only in the POS.
  medusa_open: 'is_closed = true AND status != "completed" AND status != "archived"',
};

// `all` is a real tab that adds no predicate of its own — the base filters
// (is_draft, the date range, cancelled) already describe it. Listed explicitly so
// serving the whole population is a decision rather than the accident of an
// unknown tab name falling through TAB_FILTER and matching everything.
const KNOWN_TABS = new Set<string>([...Object.keys(TAB_FILTER), "all"]);

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

function parseTs(value: unknown): number | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
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
  // An unrecognised tab name is rejected rather than silently returning every
  // order, which is what would happen if it just missed TAB_FILTER.
  if (tab && !KNOWN_TABS.has(tab)) {
    return res
      .status(400)
      .json({ error: "unknown_tab", message: `Unknown tab: ${tab}` });
  }
  if (tab && TAB_FILTER[tab]) filters.push(TAB_FILTER[tab]);
  if (payment && VALID_PAYMENTS.has(payment)) {
    // "Deposited" asks "which orders are holding money I have not used yet",
    // not "which orders are partly covered" (operator's call, 2026-07-29).
    // Those were the same question only while the deposit field held every
    // dollar, used or not; once it means the LIVE remainder they diverge, and an
    // order paid in full but invoiced in part — the case this came from — is
    // effective_payment = fully_paid while still holding a deposit.
    //
    // The partly-covered orders keep their own home: every one of them owes
    // money, so the Unpaid tab lists them (verified, 18 of 18).
    filters.push(
      payment === "deposited"
        ? "has_deposit = true"
        : `effective_payment = "${payment}"`
    );
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

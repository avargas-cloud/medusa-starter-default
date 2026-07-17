import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"

import { avgCostDollars, purchaseCostDollars } from "../../../../../lib/cost/cost-sql"
import { parseDateRange } from "../../_lib/date-range"
import { VENDOR_IS_CHINA_AGENT_SQL } from "../../../purchase-orders/_lib/china-transfer"
import {
  NET_ITEM_REVENUE,
  SALES_ACTIVE_STATUSES_SQL,
  SALES_DATE_FILTER_SQL,
  fetchCmRefundsCentsForPeriod,
} from "../../_lib/sales-revenue"
import { COGS_JOIN, COST_DOLLARS } from "../../_lib/cogs-join"

// Same canonical warehouse ids as backend/src/lib/locations.ts — inlined
// (matches the existing pattern in purchasing/snapshot, purchasing/alternatives,
// reports/purchases/factory-orders/china-inventory) instead of importing, since
// those routes never import the shared const either.
const USA_SLOC = 'sloc_01KFS2AV3TAKR141KC2D6JCGTR'
const CHINA_SLOC = 'sloc_01KQ14C1CFX30EDD722BF87HDM'

// Snapshot inventory value — same formulas as reports/purchases/factory-orders/china-inventory.
// China values at factory cost (pre-landed); Miami values at landed cost (already includes
// freight/tariff/service by the time it's on this side).
const FACTORY_COST = `COALESCE(${purchaseCostDollars("pv")}, 0)`

const LANDED_COST = `COALESCE(${avgCostDollars("pv")}, 0)`

const AVAILABLE_QTY = `GREATEST(0, il.stocked_quantity - COALESCE(il.reserved_quantity, 0))`

const INVENTORY_VALUE_JOINS = `
  FROM inventory_level il
  JOIN inventory_item ii ON ii.id = il.inventory_item_id
  JOIN product_variant_inventory_item pvii ON pvii.inventory_item_id = ii.id
  JOIN product_variant pv ON pv.id = pvii.variant_id AND pv.deleted_at IS NULL
  WHERE il.location_id = ? AND il.stocked_quantity > 0
`

async function fetchInventoryValue(pg: any, locationId: string, costExpr: string): Promise<number> {
  const result = await pg.raw(
    `SELECT COALESCE(ROUND(SUM(${AVAILABLE_QTY} * ${costExpr})::numeric, 2), 0) AS value
     ${INVENTORY_VALUE_JOINS}`,
    [locationId]
  )
  return Number(result.rows[0]?.value ?? 0)
}

// Manual "dead inventory" deduction — user-entered $ (2026-07-14): stock
// still sitting in Miami's counted value that's actually unsellable and
// hasn't been written off yet, inflating every Miami figure on this page.
// Reuses the existing generic `purchasing_config` key/value table (same one
// backing the Purchasing Analysis settings modal — GET/PUT
// /admin/purchasing/config already handles arbitrary keys) instead of adding
// a dedicated table for one scalar. Subtracted from ALL Miami values —
// live, Initial, and Final — as early as possible so downstream numbers that
// derive from those (e.g. Average Inventory for Rotation/GMROI) inherit the
// correction automatically rather than needing their own separate fix.
const MIAMI_DEAD_INVENTORY_CONFIG_KEY = 'supply_chain_miami_dead_inventory'

async function fetchMiamiDeadInventoryDeduction(pg: any): Promise<number> {
  const result = await pg.raw(
    `SELECT value FROM purchasing_config WHERE key = ? LIMIT 1`,
    [MIAMI_DEAD_INVENTORY_CONFIG_KEY]
  )
  const n = Number(result.rows[0]?.value ?? 0)
  return Number.isFinite(n) && n > 0 ? n : 0
}

// ─── Historical inventory value — reconstructed backward from live stock ───
// Mirrors the exact movement sources of admin/pos/product-history (Miami) and
// admin/pos/china-product-history (China), generalized from "one variant" to
// "every variant at the location" and from "quantity" to "quantity × current
// cost" (we don't track historical unit cost, so — same as the rest of this
// route — current cost is used as the best available estimate throughout).
// balance_at(date) = current_stocked − net_movements_between(date, now), then
// valued the SAME way fetchInventoryValue values live stock: GREATEST(0,
// balance − reserved) — reserved has no history to walk back (reservations
// aren't logged with a date the way receipts/sales are), so CURRENT reserved
// is used for every date as the best available stand-in.
// Verified 2026-07-14: fetch*InventoryValueAtDate(pg, now) reproduces
// fetchInventoryValue's live number to the cent for both locations — that
// equivalence is the correctness check for the whole reconstruction.

// Miami: sold(−) / returned(+) / received(+) / inventory-count adjusted(±).
async function fetchMiamiInventoryValueAtDate(pg: any, targetDate: string): Promise<number> {
  const result = await pg.raw(
    `WITH current_stock AS (
       SELECT pv.id AS variant_id, il.stocked_quantity AS stocked,
         COALESCE(il.reserved_quantity, 0) AS reserved, ${LANDED_COST} AS unit_cost
       FROM inventory_level il
       JOIN inventory_item ii ON ii.id = il.inventory_item_id
       JOIN product_variant_inventory_item pvii ON pvii.inventory_item_id = ii.id
       JOIN product_variant pv ON pv.id = pvii.variant_id AND pv.deleted_at IS NULL
       WHERE il.location_id = ?
     ),
     sold AS (
       SELECT ii.variant_id, SUM(ii.quantity) AS qty
       FROM pos_invoice i
       JOIN pos_invoice_item ii ON ii.invoice_id = i.id AND ii.deleted_at IS NULL
       WHERE i.deleted_at IS NULL AND i.voided_at IS NULL AND i.status <> 'voided'
         AND i.created_at >= ?
       GROUP BY ii.variant_id
     ),
     returned AS (
       SELECT cmi.variant_id, SUM(cmi.quantity) AS qty
       FROM pos_credit_memo cm
       JOIN pos_credit_memo_item cmi ON cmi.credit_memo_id = cm.id AND cmi.deleted_at IS NULL
       WHERE cm.deleted_at IS NULL AND cm.voided_at IS NULL AND cm.created_at >= ?
       GROUP BY cmi.variant_id
     ),
     received AS (
       SELECT porl.product_variant_id AS variant_id, SUM(porl.qty_received_now) AS qty
       FROM purchase_order_receipt_line porl
       JOIN purchase_order_receipt por ON por.id = porl.purchase_order_receipt_id
       WHERE por.stock_location_id = ? AND por.voided_at IS NULL AND por.deleted_at IS NULL
         AND porl.deleted_at IS NULL AND por.received_at >= ?
       GROUP BY porl.product_variant_id
     ),
     adjusted AS (
       SELECT icl.product_variant_id AS variant_id, SUM(icl.delta_applied) AS qty
       FROM inventory_count_line icl
       JOIN inventory_count ic ON ic.id = icl.inventory_count_id
       WHERE ic.stock_location_id = ? AND ic.status IN ('approved','partially_applied')
         AND ic.applied_at IS NOT NULL AND icl.deleted_at IS NULL AND ic.deleted_at IS NULL
         AND ic.voided_at IS NULL AND ic.applied_at >= ?
       GROUP BY icl.product_variant_id
     )
     SELECT COALESCE(SUM(
       GREATEST(0,
         (cs.stocked - (
           -COALESCE(sold.qty, 0) + COALESCE(returned.qty, 0) + COALESCE(received.qty, 0) + COALESCE(adjusted.qty, 0)
         )) - cs.reserved
       ) * cs.unit_cost
     ), 0) AS value
     FROM current_stock cs
     LEFT JOIN sold ON sold.variant_id = cs.variant_id
     LEFT JOIN returned ON returned.variant_id = cs.variant_id
     LEFT JOIN received ON received.variant_id = cs.variant_id
     LEFT JOIN adjusted ON adjusted.variant_id = cs.variant_id`,
    [USA_SLOC, targetDate, targetDate, USA_SLOC, targetDate, USA_SLOC, targetDate]
  )
  return Number(result.rows[0]?.value ?? 0)
}

// China: fo_receipts(+) / transfers RECEIVED in Miami(−) / manual
// china_adjustment(±). `inventory_level.stocked_quantity` at the China
// location only decrements when a transfer is RECEIVED (in Miami) — NOT at
// ship time — so unlike china-product-history's "physical_china" (a display
// metric keyed on ship date), the reconstruction that actually reproduces
// `stocked_quantity` must key on `it.received_at`.
async function fetchChinaInventoryValueAtDate(pg: any, targetDate: string): Promise<number> {
  const result = await pg.raw(
    `WITH current_stock AS (
       SELECT pv.id AS variant_id, ii.id AS inventory_item_id, il.stocked_quantity AS stocked,
         COALESCE(il.reserved_quantity, 0) AS reserved, ${FACTORY_COST} AS unit_cost
       FROM inventory_level il
       JOIN inventory_item ii ON ii.id = il.inventory_item_id
       JOIN product_variant_inventory_item pvii ON pvii.inventory_item_id = ii.id
       JOIN product_variant pv ON pv.id = pvii.variant_id AND pv.deleted_at IS NULL
       WHERE il.location_id = ?
     ),
     fo_receipts AS (
       SELECT forl.product_variant_id AS variant_id, SUM(forl.qty_received_now) AS qty
       FROM factory_order_receipt_line forl
       JOIN factory_order_receipt fore ON fore.id = forl.factory_order_receipt_id
       WHERE forl.deleted_at IS NULL AND fore.deleted_at IS NULL AND fore.status = 'applied'
         AND fore.voided_at IS NULL AND fore.stock_location_id = ? AND fore.received_at >= ?
       GROUP BY forl.product_variant_id
     ),
     transfers_received AS (
       SELECT itl.product_variant_id AS variant_id, SUM(itl.qty) AS qty
       FROM inventory_transfer_line itl
       JOIN inventory_transfer it ON it.id = itl.transfer_id
       WHERE itl.deleted_at IS NULL AND it.deleted_at IS NULL AND it.origin_country = 'CN'
         AND it.voided_at IS NULL AND it.received_at IS NOT NULL AND it.received_at >= ?
       GROUP BY itl.product_variant_id
     ),
     adjustments AS (
       SELECT cl.inventory_item_id, SUM(cl.delta) AS delta
       FROM china_adjustment_line cl
       JOIN china_adjustment ca ON ca.id = cl.china_adjustment_id
       WHERE ca.voided_at IS NULL AND ca.created_at >= ?
       GROUP BY cl.inventory_item_id
     )
     SELECT COALESCE(SUM(
       GREATEST(0,
         (cs.stocked - (
           COALESCE(fo.qty, 0) - COALESCE(tr.qty, 0) + COALESCE(adj.delta, 0)
         )) - cs.reserved
       ) * cs.unit_cost
     ), 0) AS value
     FROM current_stock cs
     LEFT JOIN fo_receipts fo ON fo.variant_id = cs.variant_id
     LEFT JOIN transfers_received tr ON tr.variant_id = cs.variant_id
     LEFT JOIN adjustments adj ON adj.inventory_item_id = cs.inventory_item_id`,
    [CHINA_SLOC, CHINA_SLOC, targetDate, targetDate, targetDate]
  )
  return Number(result.rows[0]?.value ?? 0)
}

// ─── China-agent PO valuation — real landed cost when billed ───────────────
//
// The "China → Miami" arrow is sourced entirely from `purchase_order` (the
// China purchasing agent is just a flagged vendor, same table as local
// vendors) — NOT from `inventory_transfer`. Decided with the user
// (2026-07-14): a PO exists earlier in the pipeline than its transfer link,
// so using transfers as the source would miss POs not yet converted to a
// transfer, and summing both (an earlier design of this route) double-counts
// the same shipment once both land in the same period.
//
// Per-line valuation blends two sources:
//   - BILLED qty: once a Regular Vendor Bill is confirmed for a PO line, its
//     `landed_unit_cost_cents` (unit cost + commission + freight + tariff,
//     CBM-prorated, LOCKED at confirm) is the real, final landed cost — use it.
//   - UNBILLED qty (no confirmed bill yet, or only partially billed): fall
//     back to the LANDED_COST estimate (product_variant.metadata.qb_avg_cost),
//     same estimate used everywhere else in this route, clearly an estimate
//     until the real bill lands.
// `vendor_bill_line.purchase_order_line_id` is N:1 back to `purchase_order_line`
// (a line can be billed across multiple shipments) — summing per PO line is safe,
// no double counting (verified against the existing `by-product`/`china/by-category`
// reports that already use this exact join).
const BILLED_JOIN = `
  LEFT JOIN (
    SELECT vbl.purchase_order_line_id AS pol_id,
           SUM(vbl.qty) AS billed_qty,
           SUM(vbl.qty * vbl.landed_unit_cost_cents) AS billed_cents
    FROM vendor_bill_line vbl
    JOIN vendor_bill vb ON vb.id = vbl.vendor_bill_id AND vb.deleted_at IS NULL
      AND vb.status = 'confirmed' AND vb.bill_type = 'regular'
    WHERE vbl.deleted_at IS NULL AND vbl.line_type = 'product' AND vbl.purchase_order_line_id IS NOT NULL
    GROUP BY vbl.purchase_order_line_id
  ) bl ON bl.pol_id = pol.id
`

// Effective $ for the WHOLE line — billed portion at real landed cost, the
// rest at the landed-cost estimate. Replaces `pol.total_cents` for agent lines.
const EFFECTIVE_AGENT_LINE_TOTAL_CENTS = `(
  COALESCE(bl.billed_cents, 0)
  + GREATEST(0, pol.qty_ordered - COALESCE(bl.billed_qty, 0)) * (${LANDED_COST} * 100)
)`

// Same, per unit — for multiplying against a remaining/received qty.
// Falls back to the PO's own unit_cost_cents in the (should-not-happen)
// qty_ordered = 0 case, purely as a div/0 guard.
const EFFECTIVE_AGENT_UNIT_CENTS = `COALESCE(
  ${EFFECTIVE_AGENT_LINE_TOTAL_CENTS} / NULLIF(pol.qty_ordered, 0),
  pol.unit_cost_cents
)`

// Purchase orders actually PLACED in [from, to) — draft excluded, since a
// draft PO hasn't been sent to the vendor and isn't real committed spend —
// split by whether the vendor is the China purchasing agent (Veetech). Local
// vendor lines use the PO's own total_cents (already landed — domestic, no
// freight/tariff); agent lines use the blended real/estimated landed value.
async function fetchPoSpend(pg: any, from: string, to: string) {
  const result = await pg.raw(
    `SELECT
       COALESCE(SUM(CASE WHEN NOT COALESCE(${VENDOR_IS_CHINA_AGENT_SQL}, false)
                         THEN pol.total_cents ELSE 0 END), 0)::bigint AS local_vendor_cents,
       COALESCE(SUM(CASE WHEN COALESCE(${VENDOR_IS_CHINA_AGENT_SQL}, false)
                         THEN ${EFFECTIVE_AGENT_LINE_TOTAL_CENTS} ELSE 0 END), 0)::bigint AS china_agent_cents
     FROM purchase_order po
     JOIN purchase_order_line pol ON pol.purchase_order_id = po.id AND pol.deleted_at IS NULL
     LEFT JOIN qb_vendor v ON v.id = po.vendor_id
     LEFT JOIN product_variant pv ON pv.id = pol.product_variant_id AND pv.deleted_at IS NULL
     ${BILLED_JOIN}
     WHERE po.deleted_at IS NULL AND po.status NOT IN ('draft','voided','cancelled')
       AND COALESCE(po.ordered_at, po.created_at) >= ? AND COALESCE(po.ordered_at, po.created_at) < ?`,
    [from, to]
  )
  const r = result.rows[0]
  return {
    localVendorCents: Number(r.local_vendor_cents),
    chinaAgentCents:  Number(r.china_agent_cents),
  }
}

// Factory orders actually PLACED in [from, to) — draft excluded, same reasoning
// as purchase orders — cost basis, mirrors purchase orders.
async function fetchFactoryOrderSpend(pg: any, from: string, to: string): Promise<number> {
  const result = await pg.raw(
    `SELECT COALESCE(SUM(fo.total_cents), 0)::bigint AS cents
     FROM factory_order fo
     WHERE fo.deleted_at IS NULL AND fo.status NOT IN ('draft','voided','cancelled')
       AND COALESCE(fo.ordered_at, fo.submitted_at) >= ? AND COALESCE(fo.ordered_at, fo.submitted_at) < ?`,
    [from, to]
  )
  return Number(result.rows[0]?.cents ?? 0)
}

// ─── "Period" mode, IN-PROGRESS periods (This Week / This Month) — split ───
// Received vs In-Transit. Revised 2026-07-14 (in-session correction, replaces
// the earlier "scope by when placed" design): Received is scoped by the
// REAL RECEIPT EVENT date (purchase_order_receipt.received_at) — what
// physically landed THIS period, regardless of which month the underlying PO
// was originally placed in. In Transit is the SAME period-independent "right
// now" number as Current mode (fetchCurrentPoOutstanding) — reused as-is, not
// recomputed here — because "in transit" has no natural period boundary: a PO
// placed in June that's still open in July is still in transit in July.
// This also fixes a real point of confusion: previously "This Month" and
// "Current" showed two different, hard-to-reconcile in-transit numbers for
// the exact same open POs (This Month excluded June-placed POs still open in
// July); now they always agree, and Received is the only period-scoped part.
// Cost basis: the receipt's own override when present (the actual price paid
// on that shipment), else the PO line's committed unit cost — real numbers,
// not the agent's billed/estimated-landed blend (that blend exists for
// still-open exposure where nothing better exists yet; a receipt is already
// real data).
async function fetchPeriodReceivedSplit(pg: any, from: string, to: string) {
  const result = await pg.raw(
    `SELECT
       COALESCE(SUM(CASE WHEN NOT COALESCE(${VENDOR_IS_CHINA_AGENT_SQL}, false)
                         THEN porl.qty_received_now * COALESCE(porl.unit_cost_cents_override, pol.unit_cost_cents)
                         ELSE 0 END), 0)::bigint AS vendor_received_cents,
       COALESCE(SUM(CASE WHEN COALESCE(${VENDOR_IS_CHINA_AGENT_SQL}, false)
                         THEN porl.qty_received_now * COALESCE(porl.unit_cost_cents_override, pol.unit_cost_cents)
                         ELSE 0 END), 0)::bigint AS agent_received_cents
     FROM purchase_order_receipt por
     JOIN purchase_order_receipt_line porl ON porl.purchase_order_receipt_id = por.id
     JOIN purchase_order_line pol ON pol.id = porl.purchase_order_line_id AND pol.deleted_at IS NULL
     JOIN purchase_order po ON po.id = por.purchase_order_id AND po.deleted_at IS NULL
     LEFT JOIN qb_vendor v ON v.id = po.vendor_id
     WHERE por.voided_at IS NULL
       AND por.received_at >= ? AND por.received_at < ?`,
    [from, to]
  )
  const r = result.rows[0]
  return {
    vendorReceivedCents: Number(r.vendor_received_cents),
    agentReceivedCents:  Number(r.agent_received_cents),
  }
}

// ─── "Current" mode — live pipeline exposure, no date range ────────────────
// Answers "what's still outstanding right now", independent of when the
// order was placed — the CURRENT selector's whole point.

// Purchase orders still open (submitted or partially received) — valued at
// only the REMAINING un-received qty per line (not the full PO), so a PO
// that's 476/481 received shows the ~$5 still owed, not its full $300 total.
async function fetchCurrentPoOutstanding(pg: any) {
  const result = await pg.raw(
    `SELECT
       COALESCE(SUM(CASE WHEN NOT is_agent THEN remaining_cents ELSE 0 END), 0)::bigint AS local_vendor_cents,
       COALESCE(SUM(CASE WHEN is_agent     THEN remaining_cents ELSE 0 END), 0)::bigint AS china_agent_cents
     FROM (
       SELECT
         COALESCE(${VENDOR_IS_CHINA_AGENT_SQL}, false) AS is_agent,
         CASE WHEN COALESCE(${VENDOR_IS_CHINA_AGENT_SQL}, false)
           THEN GREATEST(0, pol.qty_ordered - pol.qty_received - pol.qty_cancelled) * ${EFFECTIVE_AGENT_UNIT_CENTS}
           ELSE GREATEST(0, pol.qty_ordered - pol.qty_received - pol.qty_cancelled) * pol.unit_cost_cents
         END AS remaining_cents
       FROM purchase_order po
       JOIN purchase_order_line pol ON pol.purchase_order_id = po.id AND pol.deleted_at IS NULL
       LEFT JOIN qb_vendor v ON v.id = po.vendor_id
       LEFT JOIN product_variant pv ON pv.id = pol.product_variant_id AND pv.deleted_at IS NULL
       ${BILLED_JOIN}
       WHERE po.deleted_at IS NULL AND po.status IN ('submitted','partially_received')
     ) t`
  )
  const r = result.rows[0]
  return {
    localVendorCents: Number(r.local_vendor_cents),
    chinaAgentCents:  Number(r.china_agent_cents),
  }
}

// Factory orders still open — same remaining-qty logic as POs above.
async function fetchCurrentFoOutstanding(pg: any): Promise<number> {
  const result = await pg.raw(
    `SELECT COALESCE(SUM(
       GREATEST(0, fol.qty_ordered - fol.qty_received - fol.qty_cancelled) * fol.unit_cost_cents
     ), 0)::bigint AS cents
     FROM factory_order fo
     JOIN factory_order_line fol ON fol.factory_order_id = fo.id AND fol.deleted_at IS NULL
     WHERE fo.deleted_at IS NULL AND fo.status IN ('submitted','partially_received')`
  )
  return Number(result.rows[0]?.cents ?? 0)
}

// Net sales revenue (canonical policy — see reports/_lib/sales-revenue.ts) for
// [from, to), used to derive the daily average.
async function fetchNetRevenueCents(pg: any, from: string, to: string): Promise<number> {
  const [grossResult, refundCents] = await Promise.all([
    pg.raw(
      `SELECT COALESCE(SUM(${NET_ITEM_REVENUE}), 0)::bigint AS revenue
       FROM pos_invoice i
       JOIN pos_invoice_item pii ON pii.invoice_id = i.id AND pii.deleted_at IS NULL
       WHERE i.deleted_at IS NULL AND ${SALES_ACTIVE_STATUSES_SQL}
         AND ${SALES_DATE_FILTER_SQL}`,
      [from, to]
    ),
    fetchCmRefundsCentsForPeriod(pg, from, to),
  ])
  const grossCents = Number(grossResult.rows[0]?.revenue ?? 0)
  return Math.max(0, grossCents - refundCents)
}

// Cost of the products sold in [from, to) — same COGS basis (landed cost,
// canonical join) as reports/sales/summary. Returned already in dollars per
// COST_DOLLARS's own contract (unlike NET_ITEM_REVENUE, which is cents).
async function fetchProductCostDollars(pg: any, from: string, to: string): Promise<number> {
  const result = await pg.raw(
    `SELECT COALESCE(SUM(${COST_DOLLARS}), 0) AS cogs
     FROM pos_invoice i
     JOIN pos_invoice_item pii ON pii.invoice_id = i.id AND pii.deleted_at IS NULL
     ${COGS_JOIN}
     WHERE i.deleted_at IS NULL AND ${SALES_ACTIVE_STATUSES_SQL}
       AND ${SALES_DATE_FILTER_SQL}`,
    [from, to]
  )
  return Number(result.rows[0]?.cogs ?? 0)
}

// Bottom-left legend stats — Average Ticket (AOV, gross basis, same
// definition as reports/sales/summary's own `aov`) and unique customers, for
// the same [from, to) window used everywhere else on this page.
async function fetchSalesLegendStats(
  pg: any,
  from: string,
  to: string
): Promise<{ invoiceCount: number; grossCents: number; uniqueCustomers: number }> {
  const result = await pg.raw(
    `SELECT
       COUNT(DISTINCT i.id)::int AS invoice_count,
       COALESCE(SUM(${NET_ITEM_REVENUE}), 0)::bigint AS gross_cents,
       COUNT(DISTINCT i.customer_id) FILTER (WHERE i.customer_id IS NOT NULL)::int AS unique_customers
     FROM pos_invoice i
     JOIN pos_invoice_item pii ON pii.invoice_id = i.id AND pii.deleted_at IS NULL
     WHERE i.deleted_at IS NULL AND ${SALES_ACTIVE_STATUSES_SQL}
       AND ${SALES_DATE_FILTER_SQL}`,
    [from, to]
  )
  const r = result.rows[0]
  return {
    invoiceCount: Number(r?.invoice_count ?? 0),
    grossCents: Number(r?.gross_cents ?? 0),
    uniqueCustomers: Number(r?.unique_customers ?? 0),
  }
}

interface PoAmounts {
  // Primary number — "current" mode: live outstanding; "period" mode: created.
  localVendorCents: number
  chinaAgentCents: number
  // "period" mode only (both elapsed and in-progress): $ of POs CREATED in
  // the period, regardless of receiving status — the original single-number
  // view, confirmed correct by the user for elapsed months (2026-07-14).
  localVendorCreatedCents?: number
  chinaAgentCreatedCents?: number
  // "period" mode only (both elapsed and in-progress): $ physically RECEIVED
  // during the period (receipt-event date), regardless of which month the
  // underlying PO was placed.
  localVendorReceivedCents?: number
  chinaAgentReceivedCents?: number
  // "current" mode always, "period" mode only when in-progress: live
  // outstanding/in-transit $ — same number either way (see
  // fetchPeriodReceivedSplit's comment for why this is never period-scoped).
  localVendorInTransitCents?: number
  chinaAgentInTransitCents?: number
}

// Unifies the 3-way branch behind one shape. The user asked for MORE
// visibility, not less (2026-07-14): "current" shows just live In Transit
// (no period to speak of); "period" mode ALWAYS shows Created + Received,
// and additionally shows In Transit when the period is still in progress
// (This Week/This Month) — a closed past month has no "still open" concept
// worth repeating since Current already covers that live view.
async function fetchPoAmounts(
  pg: any,
  mode: 'current' | 'period',
  isInProgress: boolean,
  from: string,
  to: string
): Promise<PoAmounts> {
  if (mode === 'current') {
    const r = await fetchCurrentPoOutstanding(pg)
    return {
      localVendorCents: r.localVendorCents,
      chinaAgentCents: r.chinaAgentCents,
      localVendorInTransitCents: r.localVendorCents,
      chinaAgentInTransitCents: r.chinaAgentCents,
    }
  }
  const [createdR, receivedR, outstandingR] = await Promise.all([
    fetchPoSpend(pg, from, to),
    fetchPeriodReceivedSplit(pg, from, to),
    isInProgress ? fetchCurrentPoOutstanding(pg) : Promise.resolve(null),
  ])
  return {
    localVendorCents: createdR.localVendorCents,
    chinaAgentCents: createdR.chinaAgentCents,
    localVendorCreatedCents: createdR.localVendorCents,
    chinaAgentCreatedCents: createdR.chinaAgentCents,
    localVendorReceivedCents: receivedR.vendorReceivedCents,
    chinaAgentReceivedCents: receivedR.agentReceivedCents,
    ...(outstandingR
      ? {
          localVendorInTransitCents: outstandingR.localVendorCents,
          chinaAgentInTransitCents: outstandingR.chinaAgentCents,
        }
      : {}),
  }
}

interface LegendResult {
  average_ticket: number
  unique_customers: number
  // null (never 0) when the denominator is 0 — lets the frontend render "—"
  // instead of a misleading 0.00x / 0% for e.g. a brand-new location with no
  // inventory yet, rather than a division-by-zero artifact.
  inventory_rotation: number | null
  // "Purchase ROI" — return per $ actually SPENT replenishing this period
  // (a cash-flow-efficiency read: money in → money back).
  roi: number | null
  // "GMROI" (Gross Margin Return On Investment) — the standard retail
  // metric: return per $ of CAPITAL TIED UP in inventory on average this
  // period (a capital-efficiency read, not a cash-flow one). Same gross
  // profit numerator as `roi`, different denominator on purpose — user
  // request 2026-07-14: these answer two different questions and must stay
  // visually distinct, not collapse into one "ROI" figure.
  gmroi: number | null
  // Final − Initial Miami inventory $ for the period (or the hidden "this
  // month" range in "current" mode, same as the other legend inputs) —
  // positive = inventory value grew, negative = it shrank. User request
  // 2026-07-15: "vemos si en cuestión de dinero estamos aumentando el valor
  // del inventario o lo estamos reduciendo". Already-computed Initial/Final
  // (needed for Average Inventory above) — just surfaced as a delta too.
  inventory_change: number
  inventory_change_pct: number | null
}

// Bottom-left legend — Average Ticket / Unique Customers / Inventory
// Rotation / Purchase ROI / GMROI. Rotation & Purchase ROI use "Received"
// (vendor + agent, this period's fetchPeriodReceivedSplit) as the
// numerator/denominator input — user decision 2026-07-14: what actually
// replenished the shelf this period, not the period-placed Created total
// (some of which hasn't arrived yet). Rotation's denominator is Average
// Miami Inventory ((Initial+Final)/2) — the standard turnover-ratio
// convention, smooths a single point-in-time snapshot; GMROI reuses that
// same Average Inventory as ITS denominator too (that's the whole point of
// GMROI as a metric). Purchase ROI intentionally mixes windows (Sales/Cost =
// what SOLD this period; Received = what ARRIVED this period) — a rough
// purchasing-efficiency indicator, not a per-batch return calculation; sound
// as a longer-run trend, noisier for very short/volatile periods.
function buildLegend(args: {
  salesTotal: number
  productCost: number
  legendStats: { invoiceCount: number; grossCents: number; uniqueCustomers: number }
  legendReceived: { vendorReceivedCents: number; agentReceivedCents: number }
  miamiInitial: number
  miamiFinal: number
}): LegendResult {
  const { salesTotal, productCost, legendStats, legendReceived, miamiInitial, miamiFinal } = args
  const averageTicket = legendStats.invoiceCount > 0 ? (legendStats.grossCents / 100) / legendStats.invoiceCount : 0
  const receivedTotal = (legendReceived.vendorReceivedCents + legendReceived.agentReceivedCents) / 100
  const averageMiamiInventory = (miamiInitial + miamiFinal) / 2
  const grossProfit = salesTotal - productCost
  return {
    average_ticket: averageTicket,
    unique_customers: legendStats.uniqueCustomers,
    inventory_rotation: averageMiamiInventory > 0 ? receivedTotal / averageMiamiInventory : null,
    roi: receivedTotal > 0 ? grossProfit / receivedTotal : null,
    gmroi: averageMiamiInventory > 0 ? grossProfit / averageMiamiInventory : null,
    inventory_change: miamiFinal - miamiInitial,
    inventory_change_pct: miamiInitial > 0 ? (miamiFinal - miamiInitial) / miamiInitial : null,
  }
}

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const range = parseDateRange(req)
  if (!range) return res.status(400).json({ error: "from and to are required" })

  // "current" (default): live pipeline exposure — what's still outstanding
  // right now, independent of the date range (the CURRENT selector's whole
  // point). "period": what was actually placed within [from, to), including
  // already-received orders.
  const mode = req.query.mode === 'period' ? 'period' : 'current'

  const now = new Date()
  const fromDate = new Date(range.from)
  const toDate = new Date(range.to)
  // An in-progress period (This Week/This Month, or a Specific Month that
  // happens to be the current one) has `to` still in the future — that's
  // when the Received/In-Transit split applies (see fetchPoAmounts).
  // A fully-elapsed past period keeps the single "total placed" number.
  const isInProgress = mode === 'period' && toDate.getTime() > now.getTime()

  const pg = req.scope.resolve("__pg_connection__") as any

  // Clamped end of the range — future days of an in-progress period (This
  // Month) don't count toward "so far" figures. Used both for the business-
  // days divisor below and as the "Final" date for historical reconstruction.
  const effectiveTo = toDate.getTime() > now.getTime() ? now : toDate

  try {
    const [
      poAmounts,
      factoryOrderCents,
      miamiInventoryValue,
      chinaInventoryValue,
      netRevenueCents,
      productCostDollars,
      miamiInitial,
      miamiFinal,
      chinaInitial,
      chinaFinal,
      legendStats,
      legendReceived,
      miamiDeadInventoryDeduction,
    ] = await Promise.all([
      fetchPoAmounts(pg, mode, isInProgress, range.from, range.to),
      mode === 'current' ? fetchCurrentFoOutstanding(pg) : fetchFactoryOrderSpend(pg, range.from, range.to),
      fetchInventoryValue(pg, USA_SLOC, LANDED_COST),
      fetchInventoryValue(pg, CHINA_SLOC, FACTORY_COST),
      fetchNetRevenueCents(pg, range.from, range.to),
      fetchProductCostDollars(pg, range.from, range.to),
      // Initial/Final inventory value — computed for EVERY mode (needed as
      // the Average Inventory input to the Rotation legend metric below,
      // even in "current" mode where the node cards don't display them).
      fetchMiamiInventoryValueAtDate(pg, range.from),
      fetchMiamiInventoryValueAtDate(pg, effectiveTo.toISOString()),
      fetchChinaInventoryValueAtDate(pg, range.from),
      fetchChinaInventoryValueAtDate(pg, effectiveTo.toISOString()),
      // Legend stats (Average Ticket, Unique Customers) and a period-scoped
      // Received figure for Rotation/ROI — both always computed off
      // range.from/to regardless of mode, since "current" still resolves a
      // real (hidden) range under the hood for its Sales figures.
      fetchSalesLegendStats(pg, range.from, range.to),
      fetchPeriodReceivedSplit(pg, range.from, range.to),
      fetchMiamiDeadInventoryDeduction(pg),
    ])

    // Apply the manual dead-inventory deduction to EVERY Miami figure before
    // any of them are used again below — Average Inventory (Rotation/GMROI)
    // derives from Initial/Final, so correcting here propagates automatically.
    const miamiInventoryValueNet = Math.max(0, miamiInventoryValue - miamiDeadInventoryDeduction)
    const miamiInitialNet = Math.max(0, miamiInitial - miamiDeadInventoryDeduction)
    const miamiFinalNet = Math.max(0, miamiFinal - miamiDeadInventoryDeduction)

    // Business days elapsed in the selected range, clamped to "now" for
    // in-progress periods (e.g. This Month) so the average isn't diluted by
    // future days. The store is closed Sundays (verified: zero invoices on
    // any Sunday across the last 120 days) — counting them in the divisor
    // would understate the true daily average, so they're excluded here.
    let daysElapsed = 0
    for (let d = new Date(fromDate); d.getTime() < effectiveTo.getTime(); d.setDate(d.getDate() + 1)) {
      if (d.getDay() !== 0) daysElapsed++
    }
    daysElapsed = Math.max(1, daysElapsed)

    return res.json({
      mode,
      is_in_progress: isInProgress,
      from: range.from,
      to: range.to,
      days_elapsed: daysElapsed,
      local_vendors: {
        amount: poAmounts.localVendorCents / 100,
        ...(poAmounts.localVendorCreatedCents !== undefined ? { created: poAmounts.localVendorCreatedCents / 100 } : {}),
        ...(poAmounts.localVendorReceivedCents !== undefined ? { received: poAmounts.localVendorReceivedCents / 100 } : {}),
        ...(poAmounts.localVendorInTransitCents !== undefined ? { in_transit: poAmounts.localVendorInTransitCents / 100 } : {}),
      },
      factory_orders: { amount: factoryOrderCents / 100 },
      // China → Miami arrow — sourced from china-agent purchase orders (not
      // inventory_transfer, per user decision 2026-07-14), valued at real
      // landed cost where a confirmed Regular Vendor Bill exists, estimated
      // landed cost otherwise.
      transfer: {
        amount: poAmounts.chinaAgentCents / 100,
        ...(poAmounts.chinaAgentCreatedCents !== undefined ? { created: poAmounts.chinaAgentCreatedCents / 100 } : {}),
        ...(poAmounts.chinaAgentReceivedCents !== undefined ? { received: poAmounts.chinaAgentReceivedCents / 100 } : {}),
        ...(poAmounts.chinaAgentInTransitCents !== undefined ? { in_transit: poAmounts.chinaAgentInTransitCents / 100 } : {}),
      },
      miami_inventory_value: miamiInventoryValueNet,
      china_inventory_value: chinaInventoryValue,
      miami_dead_inventory_deduction: miamiDeadInventoryDeduction,
      // "period" mode only — reconstructed backward from live stock (see
      // fetchMiami/ChinaInventoryValueAtDate). Absent in "current" mode,
      // where the single live number above already is "right now". (Always
      // computed above regardless of mode — needed for the legend's Average
      // Inventory input — just not surfaced here outside "period" mode.)
      ...(mode === 'period' ? { miami_initial_inventory_value: miamiInitialNet } : {}),
      ...(mode === 'period' ? { miami_final_inventory_value: miamiFinalNet } : {}),
      ...(mode === 'period' ? { china_initial_inventory_value: chinaInitial } : {}),
      ...(mode === 'period' ? { china_final_inventory_value: chinaFinal } : {}),
      sales_total: netRevenueCents / 100,
      product_cost: productCostDollars,
      daily_sales_average: netRevenueCents / 100 / daysElapsed,
      legend: buildLegend({
        salesTotal: netRevenueCents / 100,
        productCost: productCostDollars,
        legendStats,
        legendReceived,
        miamiInitial: miamiInitialNet,
        miamiFinal: miamiFinalNet,
      }),
    })
  } catch (err) {
    console.error("[reports/purchases/supply-chain]", err)
    return res.status(500).json({ error: "Failed to fetch supply chain report" })
  }
}

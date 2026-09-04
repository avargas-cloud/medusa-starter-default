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
import { COGS_JOIN, COST_DOLLARS, fetchReturnedProductCostDollars } from "../../_lib/cogs-join"
import { cmNotFraudWriteoffSql } from "../../../../../lib/reports/fraud-writeoff"

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

// QuickBooks account that defines a purchasing-agent commission charge. Matched
// as a PREFIX (`Commission for Purchase:Veetech Representative` is the only
// sub-account in use today) and case-insensitively, so a second agent's
// sub-account under the same parent is picked up without a code change.
// See fetchAgentCommission for why the account name is the whole definition.
const COMMISSION_ACCOUNT_PREFIX = 'Commission for Purchase%'

// Owned quantity — the WHOLE shelf (2026-07-24). This used to be
// GREATEST(0, stocked - reserved), which was wrong twice over:
//
//   1. Reserved stock has not been sold. It is still owned, still on the
//      balance sheet, and QuickBooks counts it in Inventory Asset. Subtracting
//      it answered "how much can I still sell" while the page labelled the
//      answer "how much do I have". Those are different questions; the
//      availability one now lives on its own, next to the value.
//   2. The GREATEST(0, ...) floor was the only non-linear term in the whole
//      Initial -> Final walk, so it did not cancel between the two ends and
//      left a residual nobody could account for ("Reserved-stock floor").
//      Without it, Final - Initial IS the sum of the movements, by definition,
//      and the walk reconciles to $0.00 exactly.
//
// The price is that oversold SKUs now contribute NEGATIVE value instead of
// being hidden at zero. That is the correct reading — owing inventory you do
// not have is a real liability, QuickBooks treats it the same way, and it
// matches the costing engine's own rule that negative stock is liquidated,
// never clamped. The `stocked_quantity > 0` filter is gone for the same
// reason: excluding negative rows here while the reconstruction includes them
// would make the live number and the period-close number disagree.
const OWNED_QTY = `il.stocked_quantity`

const INVENTORY_VALUE_JOINS = `
  FROM inventory_level il
  JOIN inventory_item ii ON ii.id = il.inventory_item_id
  JOIN product_variant_inventory_item pvii ON pvii.inventory_item_id = ii.id
  JOIN product_variant pv ON pv.id = pvii.variant_id AND pv.deleted_at IS NULL
  WHERE il.location_id = ?
`

async function fetchInventoryValue(pg: any, locationId: string, costExpr: string): Promise<number> {
  const result = await pg.raw(
    `SELECT COALESCE(ROUND(SUM(${OWNED_QTY} * ${costExpr})::numeric, 2), 0) AS value
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
// balance_at(date) = current_stocked − net_movements_between(date, now),
// valued the SAME way fetchInventoryValue values live stock: the whole owned
// balance, no reserved subtraction and no zero floor (see OWNED_QTY). Keeping
// these two in lockstep is what makes the period-close number and the live
// number the same number.
//
// NOTE on the "self-check" this used to claim (reconstruct at now == live
// snapshot): that test is TAUTOLOGICAL and proves nothing. At t = now every
// movement CTE filters `>= now`, returns empty, and the whole expression
// collapses to `live == live` — it cannot detect a missing, mis-dated or
// wrongly-filtered movement source, which is exactly the bug class in play
// here. Three real defects hid behind it (drafts counted as sold, damaged
// returns counted as restocked, returns keyed on created_at instead of
// completed_at). The actual check is the reconciliation walk's
// `untracked_stock_movement` term, which is only zero when every movement is
// accounted for.

// Miami: sold(−) / returned(+) / received(+) / inventory-count adjusted(±).
async function fetchMiamiInventoryValueAtDate(pg: any, targetDate: string): Promise<number> {
  const result = await pg.raw(
    `WITH current_stock AS (
       SELECT pv.id AS variant_id, il.stocked_quantity AS stocked,
         ${LANDED_COST} AS unit_cost
       FROM inventory_level il
       JOIN inventory_item ii ON ii.id = il.inventory_item_id
       JOIN product_variant_inventory_item pvii ON pvii.inventory_item_id = ii.id
       JOIN product_variant pv ON pv.id = pvii.variant_id AND pv.deleted_at IS NULL
       WHERE il.location_id = ?
     ),
     -- Drafts excluded 2026-07-23 (was: status <> 'voided', which let them
     -- through): a draft invoice has moved no stock yet, so walking its
     -- quantities back misstates the reconstruction. Deliberately still keyed
     -- on created_at, NOT the canonical fiscal issued_at -- this CTE has to
     -- reproduce stocked_quantity, which moves at the real event, and
     -- issued_at is backdatable by design (see payment_batch_day).
     sold AS (
       SELECT ii.variant_id, SUM(ii.quantity) AS qty
       FROM pos_invoice i
       JOIN pos_invoice_item ii ON ii.invoice_id = i.id AND ii.deleted_at IS NULL
       WHERE i.deleted_at IS NULL AND i.voided_at IS NULL
         AND i.status NOT IN ('draft','voided')
         AND i.created_at >= ?
       GROUP BY ii.variant_id
     ),
     -- CORRECTED 2026-07-23 — this CTE used to be SUM(cmi.quantity) keyed on
     -- cm.created_at with no status filter, which misstated the reconstruction
     -- two ways: (1) damaged units are refunded but NEVER restocked
     -- (credit_memos/[id]/complete restocks exactly quantity − damaged_qty),
     -- so counting them walked stock back that never came back; (2) stock
     -- returns when the memo is COMPLETED, so a drafted-but-not-completed
     -- memo moved nothing yet. Now mirrors the real restock exactly, and its
     -- window matches the canonical refund leg (sales-revenue.ts).
     returned AS (
       SELECT cmi.variant_id, SUM(cmi.quantity - COALESCE(cmi.damaged_qty, 0)) AS qty
       FROM pos_credit_memo cm
       JOIN pos_credit_memo_item cmi ON cmi.credit_memo_id = cm.id AND cmi.deleted_at IS NULL
       WHERE cm.deleted_at IS NULL AND cm.voided_at IS NULL AND cm.status = 'completed'
        AND ${cmNotFraudWriteoffSql("cm")}
         AND COALESCE(cm.completed_at, cm.created_at) >= ?
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
       (cs.stocked - (
         -COALESCE(sold.qty, 0) + COALESCE(returned.qty, 0) + COALESCE(received.qty, 0) + COALESCE(adjusted.qty, 0)
       )) * cs.unit_cost
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
         ${FACTORY_COST} AS unit_cost
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
       (cs.stocked - (
         COALESCE(fo.qty, 0) - COALESCE(tr.qty, 0) + COALESCE(adj.delta, 0)
       )) * cs.unit_cost
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
           SUM(COALESCE(vbl.landed_total_cents, vbl.qty * vbl.landed_unit_cost_cents)) AS billed_cents
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
export async function fetchPoSpend(pg: any, from: string, to: string) {
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

// Factory orders physically RECEIVED into the China warehouse during
// [from, to), by the REAL receipt-event date — the factory-side mirror of
// fetchPeriodReceivedSplit (user request 2026-07-23: "podemos tener en factory
// orders CREATED / RECEIVED?").
//
// Valued at FACTORY_COST (purchase_cost), NOT the FO's own unit cost, for the
// same reason the Miami arrows use average_cost: goods should be counted at
// the cost they're CARRIED at once they land, and China stock is valued
// pre-landed at factory cost throughout this route. Scoped identically to the
// fo_receipts CTE of fetchChinaInventoryValueAtDate, so the arrow equals the
// movement that actually hit China inventory.
// The cohort leg (same purpose as fetchPeriodReceivedSplit's) needs the FO
// header for its placed date, which this query did not previously join at all.
export async function fetchFactoryOrderReceived(
  pg: any,
  from: string,
  to: string
): Promise<{ cents: number; cohortCents: number }> {
  const result = await pg.raw(
    `SELECT
       COALESCE(ROUND(SUM(value_cents)), 0)::bigint AS cents,
       COALESCE(ROUND(SUM(CASE WHEN in_cohort THEN value_cents ELSE 0 END)), 0)::bigint AS cohort_cents
     FROM (
       SELECT
         (COALESCE(fo.ordered_at, fo.submitted_at) >= ?
          AND COALESCE(fo.ordered_at, fo.submitted_at) < ?) AS in_cohort,
         forl.qty_received_now * ${FACTORY_COST} * 100 AS value_cents
       FROM factory_order_receipt_line forl
       JOIN factory_order_receipt fore ON fore.id = forl.factory_order_receipt_id
       JOIN factory_order fo ON fo.id = fore.factory_order_id AND fo.deleted_at IS NULL
       LEFT JOIN product_variant pv ON pv.id = forl.product_variant_id AND pv.deleted_at IS NULL
       WHERE forl.deleted_at IS NULL AND fore.deleted_at IS NULL AND fore.status = 'applied'
         AND fore.voided_at IS NULL AND fore.stock_location_id = ?
         AND fore.received_at >= ? AND fore.received_at < ?
     ) t`,
    [from, to, CHINA_SLOC, from, to]
  )
  const r = result.rows[0]
  return { cents: Number(r?.cents ?? 0), cohortCents: Number(r?.cohort_cents ?? 0) }
}

// Factory orders actually PLACED in [from, to) — draft excluded, same reasoning
// as purchase orders — cost basis, mirrors purchase orders.
export async function fetchFactoryOrderSpend(pg: any, from: string, to: string): Promise<number> {
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
// Cost basis (CORRECTED 2026-07-23 — was: the receipt's override, else the
// PO line's committed unit cost): valued at the SAME canonical cost the goods
// are carried at once they land — `average_cost` (QB average for USA product,
// real landed cost for China product; see lib/cost/cost-sql.ts), NOT the PO's
// own unit cost. The PO cost is what we OWE the vendor; for China product it
// excludes the freight/tariff/commission that the landed cost already
// includes, so valuing Received at PO cost understated what actually entered
// Miami inventory by the entire landed uplift (June 2026: agent Received read
// $22,548.55 while $30,640.74 of value landed — a $8,092 hole) and left the
// page's Initial + Received − COGS ≈ Final identity permanently open.
// This also makes Received agree with Created/In-Transit, which were ALREADY
// on a landed basis for agent lines (EFFECTIVE_AGENT_LINE_TOTAL_CENTS).
// Row set is now scoped exactly like the `received` CTE of
// fetchMiamiInventoryValueAtDate (Miami location, soft-deletes excluded, no
// purchase_order_line join) so the arrow equals the inventory movement to the
// cent — an inner join on a soft-deleted PO line used to silently drop stock
// that had physically arrived.
// The `*_cohort_cents` legs answer the question the three stacked numbers kept
// provoking (user, 2026-08-27: "casi $28500 creados, casi $28000 recibidos… y
// aun asi salen $9191.23 in transit — no cuadra"): how much of what ARRIVED
// this period belongs to the orders PLACED this period. Received mixes
// cohorts by design — August 2026 landed $8,685.49 of merchandise ordered in
// July — so `created − received` is a subtraction across two different sets of
// POs and can never equal In Transit. Scoped to the cohort, the identity does
// close: $19,289.58 received + $9,191.23 still in transit = $28,480.81 created,
// to the cent, for the China lane that month.
export async function fetchPeriodReceivedSplit(pg: any, from: string, to: string) {
  const result = await pg.raw(
    `SELECT
       COALESCE(ROUND(SUM(CASE WHEN NOT is_agent THEN value_cents ELSE 0 END)), 0)::bigint
         AS vendor_received_cents,
       COALESCE(ROUND(SUM(CASE WHEN is_agent     THEN value_cents ELSE 0 END)), 0)::bigint
         AS agent_received_cents,
       COALESCE(ROUND(SUM(CASE WHEN NOT is_agent AND in_cohort THEN value_cents ELSE 0 END)), 0)::bigint
         AS vendor_received_cohort_cents,
       COALESCE(ROUND(SUM(CASE WHEN is_agent     AND in_cohort THEN value_cents ELSE 0 END)), 0)::bigint
         AS agent_received_cohort_cents
     FROM (
       SELECT
         COALESCE(${VENDOR_IS_CHINA_AGENT_SQL}, false) AS is_agent,
         (COALESCE(po.ordered_at, po.created_at) >= ?
          AND COALESCE(po.ordered_at, po.created_at) < ?) AS in_cohort,
         porl.qty_received_now * ${LANDED_COST} * 100 AS value_cents
       FROM purchase_order_receipt por
       JOIN purchase_order_receipt_line porl ON porl.purchase_order_receipt_id = por.id
         AND porl.deleted_at IS NULL
       JOIN purchase_order po ON po.id = por.purchase_order_id AND po.deleted_at IS NULL
       LEFT JOIN qb_vendor v ON v.id = po.vendor_id
       LEFT JOIN product_variant pv ON pv.id = porl.product_variant_id AND pv.deleted_at IS NULL
       WHERE por.voided_at IS NULL AND por.deleted_at IS NULL
         AND por.stock_location_id = ?
         AND por.received_at >= ? AND por.received_at < ?
     ) t`,
    [from, to, USA_SLOC, from, to]
  )
  const r = result.rows[0]
  return {
    vendorReceivedCents: Number(r.vendor_received_cents),
    agentReceivedCents:  Number(r.agent_received_cents),
    vendorReceivedCohortCents: Number(r.vendor_received_cohort_cents),
    agentReceivedCohortCents:  Number(r.agent_received_cohort_cents),
  }
}

// Purchasing-agent commission billed in [from, to) — the third number on the
// China → Miami arrow (user request 2026-08-13).
//
// SOURCED FROM THE BILLS, never recomputed as 15% of anything. Every one of
// the 25 commission bills in production is exactly 15.00% of its PO's subtotal
// (measured 2026-08-13, to the cent), so a hardcoded rate would agree with the
// bills today and lie the day the contract's rate moves or a shipment carries
// a negotiated adjustment. Same discipline the drift engine already applies:
// the agent's commission is reconciled, never recomputed.
//
// DATED BY `document_date`, NOT by the receipt event that `Received` above is
// scoped to — a deliberate mismatch, decided by the user on 2026-08-13: there
// is a contract with a $2,000/month floor and the contract counts by INVOICE
// date, so the report has to keep the contract's own calendar. Consequence
// worth knowing before "fixing" it: Veetech invoices its commission when the
// goods SHIP, 1-4 weeks before they land, so this number and the Received
// number directly above it describe DIFFERENT shipments in the same month
// (August 2026: $1,666.93 of commission against $2,571.88 of merchandise
// received at purchase cost). Their ratio is not the commission rate.
//
// The account name IS the definition — no `is_china_agent` filter. If another
// agent ever bills against the same account, that is still purchasing-agent
// commission on this lane and belongs in this number.
//
// Drafts are excluded (user decision, same day): only a confirmed bill counts.
// Today that is load-bearing, not cosmetic — one draft (VB-1095, $596.46) is
// the difference between August reading above or below the contract floor.
//
// The line amount is `qty * unit_cost_cents`: `vendor_bill_line.amount_cents`
// is NULL on all 25 commission lines, so reading that column would report $0.
// Exported so `scripts/verify/verify-supply-chain-commission.ts` exercises THIS
// function against independently-measured expected totals, instead of a copy of
// its SQL that would agree with a mutation.
export async function fetchAgentCommission(
  pg: any,
  from: string,
  to: string
): Promise<{ cents: number; orders: number }> {
  const result = await pg.raw(
    `SELECT
       COALESCE(SUM(vbl.qty * vbl.unit_cost_cents), 0)::bigint AS cents,
       COUNT(DISTINCT COALESCE(vb.purchase_order_id, vb.id)) AS orders
     FROM vendor_bill vb
     JOIN vendor_bill_line vbl ON vbl.vendor_bill_id = vb.id AND vbl.deleted_at IS NULL
     WHERE vb.deleted_at IS NULL
       AND vb.status IN ('confirmed', 'synced')
       AND vbl.qb_account_full_name ILIKE ?
       AND COALESCE(vb.document_date, vb.created_at) >= ?
       AND COALESCE(vb.document_date, vb.created_at) < ?`,
    [COMMISSION_ACCOUNT_PREFIX, from, to]
  )
  const r = result.rows[0]
  return { cents: Number(r?.cents ?? 0), orders: Number(r?.orders ?? 0) }
}

// Inventory-count adjustments applied to Miami in [from, to) — the third
// movement source of the Miami ledger (alongside Received and Sold) and,
// until now, the only one with no representation anywhere on the page.
// Physical counts that write stock off (or find it) move real money in the
// warehouse: June 2026 was −2,585 units / −$3,845.88, which read as an
// unexplained gap between the arrows and the Initial→Final inventory swing.
// Signed: negative = shrinkage, positive = found stock. Valued at the same
// canonical `average_cost` as the inventory itself, and scoped identically to
// the `adjusted` CTE of fetchMiamiInventoryValueAtDate so the number is
// exactly the adjustment component of Final − Initial.
async function fetchInventoryAdjustments(
  pg: any,
  from: string,
  to: string
): Promise<{ value: number; units: number }> {
  const result = await pg.raw(
    `SELECT
       COALESCE(ROUND(SUM(icl.delta_applied * ${LANDED_COST})::numeric, 2), 0) AS value,
       COALESCE(SUM(icl.delta_applied), 0)::int AS units
     FROM inventory_count_line icl
     JOIN inventory_count ic ON ic.id = icl.inventory_count_id
     LEFT JOIN product_variant pv ON pv.id = icl.product_variant_id AND pv.deleted_at IS NULL
     WHERE ic.stock_location_id = ? AND ic.status IN ('approved','partially_applied')
       AND ic.applied_at IS NOT NULL AND icl.deleted_at IS NULL AND ic.deleted_at IS NULL
       AND ic.voided_at IS NULL
       AND ic.applied_at >= ? AND ic.applied_at < ?`,
    [USA_SLOC, from, to]
  )
  return {
    value: Number(result.rows[0]?.value ?? 0),
    units: Number(result.rows[0]?.units ?? 0),
  }
}

// The two Miami ledger terms the reconciliation panel needs in order to name
// EVERY dollar of the Initial → Final walk instead of leaving a residual.
// Reconstructs both period-end balances in ONE pass over the same movement
// sources as fetchMiamiInventoryValueAtDate (same filters, same
// location-scoped variant set, so the two can never drift), then reports:
//
//   netSold — what the stock ledger actually removed for sales, net of
//     restocked returns, valued at TODAY's average_cost. Not a second opinion
//     on COGS: the page charges Product Cost at each line's FROZEN cost
//     snapshot (what the goods cost the day they sold — the accounting truth,
//     and what QuickBooks agrees with), while the reconstruction has no
//     historical unit cost and values every unit at today's. Subtracting the
//     two gives the cost-basis term by name.
//
// The zero floor that used to need its own term here is gone (2026-07-24):
// inventory is valued on the whole owned balance now, so the walk has no
// non-linear step left and needs no floor line to absorb one.
async function fetchMiamiPeriodLedger(
  pg: any,
  from: string,
  to: string
): Promise<{ netSold: number }> {
  const result = await pg.raw(
    `WITH current_stock AS (
       SELECT pv.id AS variant_id, il.stocked_quantity AS stocked,
         ${LANDED_COST} AS unit_cost
       FROM inventory_level il
       JOIN inventory_item ii ON ii.id = il.inventory_item_id
       JOIN product_variant_inventory_item pvii ON pvii.inventory_item_id = ii.id
       JOIN product_variant pv ON pv.id = pvii.variant_id AND pv.deleted_at IS NULL
       WHERE il.location_id = ?
     ),
     -- Each movement CTE reports its total AFTER 'from' and AFTER 'to' in one
     -- pass; the difference is the movement INSIDE the period. Same filters as
     -- fetchMiamiInventoryValueAtDate, deliberately duplicated rather than
     -- shared so a future edit there fails loudly here instead of drifting.
     sold AS (
       SELECT ii.variant_id,
         COALESCE(SUM(ii.quantity) FILTER (WHERE i.created_at >= ?), 0) AS qty_from,
         COALESCE(SUM(ii.quantity) FILTER (WHERE i.created_at >= ?), 0) AS qty_to
       FROM pos_invoice i
       JOIN pos_invoice_item ii ON ii.invoice_id = i.id AND ii.deleted_at IS NULL
       WHERE i.deleted_at IS NULL AND i.voided_at IS NULL
         AND i.status NOT IN ('draft','voided')
         AND i.created_at >= ?
       GROUP BY ii.variant_id
     ),
     returned AS (
       SELECT cmi.variant_id,
         COALESCE(SUM(cmi.quantity - COALESCE(cmi.damaged_qty, 0))
           FILTER (WHERE COALESCE(cm.completed_at, cm.created_at) >= ?), 0) AS qty_from,
         COALESCE(SUM(cmi.quantity - COALESCE(cmi.damaged_qty, 0))
           FILTER (WHERE COALESCE(cm.completed_at, cm.created_at) >= ?), 0) AS qty_to
       FROM pos_credit_memo cm
       JOIN pos_credit_memo_item cmi ON cmi.credit_memo_id = cm.id AND cmi.deleted_at IS NULL
       WHERE cm.deleted_at IS NULL AND cm.voided_at IS NULL AND cm.status = 'completed'
        AND ${cmNotFraudWriteoffSql("cm")}
         AND COALESCE(cm.completed_at, cm.created_at) >= ?
       GROUP BY cmi.variant_id
     ),
     received AS (
       SELECT porl.product_variant_id AS variant_id,
         COALESCE(SUM(porl.qty_received_now) FILTER (WHERE por.received_at >= ?), 0) AS qty_from,
         COALESCE(SUM(porl.qty_received_now) FILTER (WHERE por.received_at >= ?), 0) AS qty_to
       FROM purchase_order_receipt_line porl
       JOIN purchase_order_receipt por ON por.id = porl.purchase_order_receipt_id
       WHERE por.stock_location_id = ? AND por.voided_at IS NULL AND por.deleted_at IS NULL
         AND porl.deleted_at IS NULL AND por.received_at >= ?
       GROUP BY porl.product_variant_id
     ),
     adjusted AS (
       SELECT icl.product_variant_id AS variant_id,
         COALESCE(SUM(icl.delta_applied) FILTER (WHERE ic.applied_at >= ?), 0) AS qty_from,
         COALESCE(SUM(icl.delta_applied) FILTER (WHERE ic.applied_at >= ?), 0) AS qty_to
       FROM inventory_count_line icl
       JOIN inventory_count ic ON ic.id = icl.inventory_count_id
       WHERE ic.stock_location_id = ? AND ic.status IN ('approved','partially_applied')
         AND ic.applied_at IS NOT NULL AND icl.deleted_at IS NULL AND ic.deleted_at IS NULL
         AND ic.voided_at IS NULL AND ic.applied_at >= ?
       GROUP BY icl.product_variant_id
     ),
     balances AS (
       SELECT cs.unit_cost,
         (cs.stocked - (
           -COALESCE(s.qty_from, 0) + COALESCE(r.qty_from, 0)
           + COALESCE(rc.qty_from, 0) + COALESCE(a.qty_from, 0)
         )) AS bal_initial,
         (cs.stocked - (
           -COALESCE(s.qty_to, 0) + COALESCE(r.qty_to, 0)
           + COALESCE(rc.qty_to, 0) + COALESCE(a.qty_to, 0)
         )) AS bal_final,
         (COALESCE(s.qty_from, 0) - COALESCE(s.qty_to, 0)) AS sold_in_period,
         (COALESCE(r.qty_from, 0) - COALESCE(r.qty_to, 0)) AS returned_in_period
       FROM current_stock cs
       LEFT JOIN sold s      ON s.variant_id  = cs.variant_id
       LEFT JOIN returned r  ON r.variant_id  = cs.variant_id
       LEFT JOIN received rc ON rc.variant_id = cs.variant_id
       LEFT JOIN adjusted a  ON a.variant_id  = cs.variant_id
     )
     SELECT
       COALESCE(ROUND(SUM(unit_cost * (sold_in_period - returned_in_period))::numeric, 2), 0) AS net_sold
     FROM balances`,
    [
      USA_SLOC,
      from, to, from,            // sold
      from, to, from,            // returned
      from, to, USA_SLOC, from,  // received
      from, to, USA_SLOC, from,  // adjusted
    ]
  )
  return { netSold: Number(result.rows[0]?.net_sold ?? 0) }
}

// ─── "Current" mode — live pipeline exposure, no date range ────────────────
// Answers "what's still outstanding right now", independent of when the
// order was placed — the CURRENT selector's whole point.

// Purchase orders still open (submitted or partially received) — valued at
// only the REMAINING un-received qty per line (not the full PO), so a PO
// that's 476/481 received shows the ~$5 still owed, not its full $300 total.
// `cohort` is optional and NEVER narrows the headline number — In Transit stays
// the period-independent live figure it has always been (see
// fetchPeriodReceivedSplit). It only adds the sub-total of open POs that were
// PLACED inside [from, to), which is the half of the arrow's arithmetic that was
// invisible: in August 2026 the whole $9,191.23 happens to be August-placed, but
// a PO dragged over from June is still in transit in August and would leave even
// the cohort-scoped identity short — the sub-line is what makes that visible
// instead of leaving the reader to subtract two numbers that never matched.
export async function fetchCurrentPoOutstanding(pg: any, cohort?: { from: string; to: string }) {
  const result = await pg.raw(
    `SELECT
       COALESCE(SUM(CASE WHEN NOT is_agent THEN remaining_cents ELSE 0 END), 0)::bigint AS local_vendor_cents,
       COALESCE(SUM(CASE WHEN is_agent     THEN remaining_cents ELSE 0 END), 0)::bigint AS china_agent_cents,
       COALESCE(SUM(CASE WHEN NOT is_agent AND in_cohort THEN remaining_cents ELSE 0 END), 0)::bigint
         AS local_vendor_cohort_cents,
       COALESCE(SUM(CASE WHEN is_agent     AND in_cohort THEN remaining_cents ELSE 0 END), 0)::bigint
         AS china_agent_cohort_cents
     FROM (
       SELECT
         COALESCE(${VENDOR_IS_CHINA_AGENT_SQL}, false) AS is_agent,
         ${cohort
           ? `(COALESCE(po.ordered_at, po.created_at) >= ?
              AND COALESCE(po.ordered_at, po.created_at) < ?)`
           : `false`} AS in_cohort,
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
     ) t`,
    cohort ? [cohort.from, cohort.to] : []
  )
  const r = result.rows[0]
  return {
    localVendorCents: Number(r.local_vendor_cents),
    chinaAgentCents:  Number(r.china_agent_cents),
    localVendorCohortCents: Number(r.local_vendor_cohort_cents),
    chinaAgentCohortCents:  Number(r.china_agent_cohort_cents),
  }
}

// Factory orders still open — same remaining-qty logic as POs above, and the
// same optional cohort leg (FOs placed inside the period).
export async function fetchCurrentFoOutstanding(
  pg: any,
  cohort?: { from: string; to: string }
): Promise<{ cents: number; cohortCents: number }> {
  const result = await pg.raw(
    `SELECT
       COALESCE(SUM(remaining_cents), 0)::bigint AS cents,
       COALESCE(SUM(CASE WHEN in_cohort THEN remaining_cents ELSE 0 END), 0)::bigint AS cohort_cents
     FROM (
       SELECT
         ${cohort
           ? `(COALESCE(fo.ordered_at, fo.submitted_at) >= ?
              AND COALESCE(fo.ordered_at, fo.submitted_at) < ?)`
           : `false`} AS in_cohort,
         GREATEST(0, fol.qty_ordered - fol.qty_received - fol.qty_cancelled) * fol.unit_cost_cents
           AS remaining_cents
       FROM factory_order fo
       JOIN factory_order_line fol ON fol.factory_order_id = fo.id AND fol.deleted_at IS NULL
       WHERE fo.deleted_at IS NULL AND fo.status IN ('submitted','partially_received')
     ) t`,
    cohort ? [cohort.from, cohort.to] : []
  )
  const r = result.rows[0]
  return { cents: Number(r?.cents ?? 0), cohortCents: Number(r?.cohort_cents ?? 0) }
}

// Net sales revenue (canonical policy — see reports/_lib/sales-revenue.ts) for
// [from, to), used to derive the daily average. Returns the refund leg too:
// it's already netted OUT of `netCents`, and the Sales pill surfaces it as its
// own "Returns" row (user request 2026-07-23) so the deduction is visible
// rather than silently baked into Sales.
async function fetchNetRevenue(
  pg: any,
  from: string,
  to: string
): Promise<{ netCents: number; refundCents: number }> {
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
  return { netCents: Math.max(0, grossCents - refundCents), refundCents }
}

// Cost of the products sold in [from, to), NET of the cost of merchandise
// returned to stock — same COGS basis (landed cost, canonical join) as
// reports/sales/summary. Returned already in dollars per COST_DOLLARS's own
// contract (unlike NET_ITEM_REVENUE, which is cents).
//
// The returns leg was added 2026-07-23: `sales_total` has always been NET of
// refunds, so charging gross COGS against net revenue understated gross profit
// (and with it Purchase ROI / GMROI, which both derive from it). Both legs now
// use the canonical period policy — sales by `issued_at`, returns by
// `completed_at` — so a return processed this month reverses this month's cost
// even when the original sale was last month.
async function fetchProductCostDollars(
  pg: any,
  from: string,
  to: string
): Promise<{ gross: number; returned: number; net: number }> {
  const [soldResult, returned] = await Promise.all([
    pg.raw(
      `SELECT COALESCE(SUM(${COST_DOLLARS}), 0) AS cogs
       FROM pos_invoice i
       JOIN pos_invoice_item pii ON pii.invoice_id = i.id AND pii.deleted_at IS NULL
       ${COGS_JOIN}
       WHERE i.deleted_at IS NULL AND ${SALES_ACTIVE_STATUSES_SQL}
         AND ${SALES_DATE_FILTER_SQL}`,
      [from, to]
    ),
    fetchReturnedProductCostDollars(pg, from, to),
  ])
  const gross = Number(soldResult.rows[0]?.cogs ?? 0)
  return { gross, returned, net: gross - returned }
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
  // The COHORT slice of the two above: received in the period AND placed in the
  // period. Without it, Created and Received look like two ends of one
  // subtraction when they describe different sets of POs entirely.
  localVendorReceivedCohortCents?: number
  chinaAgentReceivedCohortCents?: number
  // "current" mode always, "period" mode only when in-progress: live
  // outstanding/in-transit $ — same number either way (see
  // fetchPeriodReceivedSplit's comment for why this is never period-scoped).
  localVendorInTransitCents?: number
  chinaAgentInTransitCents?: number
  // "period" mode, in-progress only: the slice of that live figure whose POs
  // were placed inside the period. Equal to the full figure when nothing older
  // is still open — which is exactly the fact worth showing.
  localVendorInTransitCohortCents?: number
  chinaAgentInTransitCohortCents?: number
  // "period" mode only: what the purchasing agent BILLED in the period, by the
  // bill's document date (see fetchAgentCommission — deliberately NOT the
  // receipt date the Received figures above use). China lane only; local
  // vendors have no agent and therefore no counterpart field.
  agentCommissionCents?: number
  agentCommissionOrders?: number
}

// Factory orders, same 3-way branch as fetchPoAmounts — "current" shows live
// outstanding, "period" shows Created + Received, plus In Transit while the
// period is still running. Reuses PoFlowAmounts' field names so the frontend
// renders this arrow through the exact same buildPoRows() path as the two
// purchase-order arrows instead of a special case (2026-07-23).
async function fetchFactoryOrderAmounts(
  pg: any,
  mode: 'current' | 'period',
  isInProgress: boolean,
  from: string,
  to: string
): Promise<{
  amount: number
  created?: number
  received?: number
  received_this_period?: number
  in_transit?: number
  in_transit_this_period?: number
}> {
  if (mode === 'current') {
    const outstanding = await fetchCurrentFoOutstanding(pg)
    return { amount: outstanding.cents / 100, in_transit: outstanding.cents / 100 }
  }
  const [createdCents, received, outstanding] = await Promise.all([
    fetchFactoryOrderSpend(pg, from, to),
    fetchFactoryOrderReceived(pg, from, to),
    isInProgress ? fetchCurrentFoOutstanding(pg, { from, to }) : Promise.resolve(null),
  ])
  return {
    amount: createdCents / 100,
    created: createdCents / 100,
    received: received.cents / 100,
    received_this_period: received.cohortCents / 100,
    ...(outstanding !== null
      ? {
          in_transit: outstanding.cents / 100,
          in_transit_this_period: outstanding.cohortCents / 100,
        }
      : {}),
  }
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
  const [createdR, receivedR, outstandingR, commissionR] = await Promise.all([
    fetchPoSpend(pg, from, to),
    fetchPeriodReceivedSplit(pg, from, to),
    isInProgress ? fetchCurrentPoOutstanding(pg, { from, to }) : Promise.resolve(null),
    fetchAgentCommission(pg, from, to),
  ])
  return {
    localVendorCents: createdR.localVendorCents,
    chinaAgentCents: createdR.chinaAgentCents,
    localVendorCreatedCents: createdR.localVendorCents,
    chinaAgentCreatedCents: createdR.chinaAgentCents,
    localVendorReceivedCents: receivedR.vendorReceivedCents,
    chinaAgentReceivedCents: receivedR.agentReceivedCents,
    localVendorReceivedCohortCents: receivedR.vendorReceivedCohortCents,
    chinaAgentReceivedCohortCents: receivedR.agentReceivedCohortCents,
    agentCommissionCents: commissionR.cents,
    agentCommissionOrders: commissionR.orders,
    ...(outstandingR
      ? {
          localVendorInTransitCents: outstandingR.localVendorCents,
          chinaAgentInTransitCents: outstandingR.chinaAgentCents,
          localVendorInTransitCohortCents: outstandingR.localVendorCohortCents,
          chinaAgentInTransitCohortCents: outstandingR.chinaAgentCohortCents,
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
      factoryOrderAmounts,
      miamiInventoryValue,
      chinaInventoryValue,
      revenue,
      productCostDollars,
      miamiInitial,
      miamiFinal,
      chinaInitial,
      chinaFinal,
      legendStats,
      legendReceived,
      miamiDeadInventoryDeduction,
      inventoryAdjustments,
      periodLedger,
    ] = await Promise.all([
      fetchPoAmounts(pg, mode, isInProgress, range.from, range.to),
      fetchFactoryOrderAmounts(pg, mode, isInProgress, range.from, range.to),
      fetchInventoryValue(pg, USA_SLOC, LANDED_COST),
      fetchInventoryValue(pg, CHINA_SLOC, FACTORY_COST),
      fetchNetRevenue(pg, range.from, range.to),
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
      // Miami inventory-count adjustments for the period — the third Miami
      // movement source, surfaced as its own vertical flow above the
      // warehouse node (user request 2026-07-23).
      fetchInventoryAdjustments(pg, range.from, range.to),
      // Only used to NAME the cost-basis term of the reconciliation below —
      // never displayed as a cost figure in its own right.
      fetchMiamiPeriodLedger(pg, range.from, effectiveTo.toISOString()),
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

    // ─── Reconciliation — "where did every number come from?" ─────────────
    // Walks Initial → Final as an explicit chain instead of leaving the
    // reader to guess why the arrows don't add up to the warehouse's swing
    // (user request 2026-07-23). EVERY term is computed and named — there is
    // deliberately no "unexplained" plug, since a figure a colleague can't
    // account for is worse than no figure at all:
    //   • cost_basis — Product Cost is charged at each line's frozen cost
    //     snapshot; the Initial/Final reconstruction values the same units at
    //     today's cost (no historical unit cost exists to use instead).
    //   • untracked_stock_movement — what's STILL left after all of the above,
    //     and the only honest name for it: stock that moved in Miami without
    //     going through invoices, credit memos, PO receipts or inventory
    //     counts — i.e. a direct SQL/script write, or a movement source this
    //     ledger doesn't know about yet. It is NOT a rounding bucket: at $0
    //     the page is fully explained, and any drift from $0 is a real signal
    //     worth chasing (the alarm the old tautological self-check could
    //     never ring).
    const receivedLocal = (poAmounts.localVendorReceivedCents ?? 0) / 100
    const receivedChina = (poAmounts.chinaAgentReceivedCents ?? 0) / 100
    const costBasis = productCostDollars.net - periodLedger.netSold
    const chainBeforeResidual =
      miamiInitialNet + receivedLocal + receivedChina - productCostDollars.net
      + inventoryAdjustments.value + costBasis
    const reconciliation = {
      initial_inventory: miamiInitialNet,
      received_local: receivedLocal,
      received_china: receivedChina,
      product_cost_net: productCostDollars.net,
      inventory_adjustments: inventoryAdjustments.value,
      cost_basis: costBasis,
      untracked_stock_movement: miamiFinalNet - chainBeforeResidual,
      final_inventory: miamiFinalNet,
    }

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
        ...(poAmounts.localVendorReceivedCohortCents !== undefined ? { received_this_period: poAmounts.localVendorReceivedCohortCents / 100 } : {}),
        ...(poAmounts.localVendorInTransitCents !== undefined ? { in_transit: poAmounts.localVendorInTransitCents / 100 } : {}),
        ...(poAmounts.localVendorInTransitCohortCents !== undefined ? { in_transit_this_period: poAmounts.localVendorInTransitCohortCents / 100 } : {}),
      },
      // Factories → China arrow. Same shape as the two PO arrows: Created is
      // what was placed with the factories in the period, Received is what
      // physically landed in the China warehouse (receipt-event date, valued
      // at factory cost — what China stock is carried at).
      factory_orders: factoryOrderAmounts,
      // China → Miami arrow — sourced from china-agent purchase orders (not
      // inventory_transfer, per user decision 2026-07-14), valued at real
      // landed cost where a confirmed Regular Vendor Bill exists, estimated
      // landed cost otherwise.
      transfer: {
        amount: poAmounts.chinaAgentCents / 100,
        ...(poAmounts.chinaAgentCreatedCents !== undefined ? { created: poAmounts.chinaAgentCreatedCents / 100 } : {}),
        ...(poAmounts.chinaAgentReceivedCents !== undefined ? { received: poAmounts.chinaAgentReceivedCents / 100 } : {}),
        // The cohort slice — see fetchPeriodReceivedSplit for why Created minus
        // Received never equalled In Transit without it.
        ...(poAmounts.chinaAgentReceivedCohortCents !== undefined ? { received_this_period: poAmounts.chinaAgentReceivedCohortCents / 100 } : {}),
        ...(poAmounts.chinaAgentInTransitCents !== undefined ? { in_transit: poAmounts.chinaAgentInTransitCents / 100 } : {}),
        ...(poAmounts.chinaAgentInTransitCohortCents !== undefined ? { in_transit_this_period: poAmounts.chinaAgentInTransitCohortCents / 100 } : {}),
        // What the agent invoiced in the period, by BILL DOCUMENT DATE — a
        // different event from `received` above, on purpose (fetchAgentCommission).
        // Absent in "current" mode, which has no period to bill against.
        ...(poAmounts.agentCommissionCents !== undefined ? { commission: poAmounts.agentCommissionCents / 100 } : {}),
        ...(poAmounts.agentCommissionOrders !== undefined ? { commission_orders: poAmounts.agentCommissionOrders } : {}),
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
      sales_total: revenue.netCents / 100,
      // NET of the cost of merchandise returned to stock (see
      // fetchProductCostDollars) — pairs with `sales_total`, which has always
      // been net of the matching refunds. Gross/returned legs exposed too so
      // the netting is inspectable, not just asserted.
      product_cost: productCostDollars.net,
      product_cost_gross: productCostDollars.gross,
      product_cost_returned: productCostDollars.returned,
      // Refunds (credit memos completed in the period) — ALREADY subtracted
      // from `sales_total` and therefore from `daily_sales_average`; exposed
      // so the Sales pill can show the deduction instead of hiding it.
      returns_total: revenue.refundCents / 100,
      daily_sales_average: revenue.netCents / 100 / daysElapsed,
      // Signed $ / units that inventory counts added to (or wrote off from)
      // Miami this period — negative = shrinkage.
      inventory_adjustment_value: inventoryAdjustments.value,
      inventory_adjustment_units: inventoryAdjustments.units,
      // "period" mode only — the Initial → Final walk. Meaningless in
      // "current" mode, which has no period to reconcile.
      ...(mode === 'period' ? { reconciliation } : {}),
      legend: buildLegend({
        salesTotal: revenue.netCents / 100,
        productCost: productCostDollars.net,
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

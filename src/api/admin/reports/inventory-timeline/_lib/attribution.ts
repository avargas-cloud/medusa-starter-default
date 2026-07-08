/**
 * FIFO attribution for the Inventory Timeline (China warehouse aging) report.
 *
 * China stock is a single fungible pool per `inventory_item_id` — the schema has
 * NO record-level lineage tying an outbound transfer/shipment back to a specific
 * Factory Order receipt lot. To render "one row per received lot" split across the
 * lifecycle, we attribute the pool across the receipt lots using FIFO (oldest lot
 * consumed first).
 *
 * Each unit that a Factory Order brought INTO China is, at any moment, in exactly
 * one of three buckets — and they sum, per item, to the total FO-received qty:
 *
 *   EN MIAMI    (miami_qty)     — shipped out AND received in the USA warehouse.
 *                                 China `stocked_quantity` only drops at RECEIVE,
 *                                 so this == totalReceived − stocked_quantity.
 *   EN TRÁNSITO (in_transit_qty)— on a shipped inventory_transfer not yet received.
 *                                 Physically left China but still carried in
 *                                 `stocked_quantity` (stock = physical + in_transit).
 *   EN CHINA    (current_qty)   — still physically sitting in the agent's warehouse,
 *                                 still aging. == stocked_quantity − in_transit.
 *
 * FIFO ordering: the "furthest along" units belong to the OLDEST inbound lots, so
 * we consume oldest-first in the order  Miami → In-Transit → In-China. Equivalent
 * cumulative-axis form: lay every lot end-to-end on [0, totalReceived); two cut
 * points (miamiCut, transitCut) slice that axis into the three buckets, and each
 * lot takes the overlap of its slice with each region. A single lot can straddle
 * two buckets (e.g. 50 Miami / 30 in-transit / 20 in-China).
 *
 * Invariant: for every inventory_item_id, Σ current_qty across its lots (+ any
 * residual rows) exactly equals the live physical China stock (stocked − inTransit).
 * When receipt history can't explain physical stock (over-received adjustments →
 * positive surplus, or negative/over-shipped stock → deficit), the residual is
 * surfaced as an explicit synthetic row instead of being smeared or clamped.
 *
 * Manual lots: physical surplus that came from an inventory adjustment has no FO
 * receipt, so it lands in the positive "unattributed" residual. The operator can
 * layer manual lots over that surplus (an FO + received date + qty, split as
 * needed) purely for aging control — the underlying stock stays unattributed.
 */

export interface ReceiptInput {
  line_id: string
  fo_number: string | null
  fo_id: string | null
  receipt_number: string | null
  sku: string
  description: string | null
  qty_received: number
  /** ISO timestamp of the parent receipt header (when this lot landed in China). */
  received_at: string
}

export interface StockInput {
  inventory_item_id: string
  sku: string
  description: string | null
  stocked: number
  /** Units on shipped-but-not-yet-received transfers (left China, still in `stocked`). */
  in_transit: number
}

export interface ManualLotInput {
  id: string
  fo_number: string
  received_at: string | null
  qty: number
  note: string | null
}

export type TimelineRowKind = "receipt" | "unattributed" | "deficit" | "manual"

export interface TimelineRow {
  key: string
  kind: TimelineRowKind
  inventory_item_id: string
  fo_number: string | null
  fo_id: string | null
  receipt_number: string | null
  sku: string
  description: string | null
  qty_received: number
  received_at: string | null
  /** Shipped out AND received in the USA warehouse. */
  miami_qty: number
  /** Shipped out, still in transit (not yet received in the USA). */
  in_transit_qty: number
  /** Still physically in the China warehouse (aging). */
  current_qty: number
  manual_lot_id?: string
  /** Operator's Excel FO number(s) for this SKU — display-only cross-reference
   *  (the `fo_number` column is the system FIFO-attributed FO). Attached by the
   *  route from `inventory_item.metadata.china_fo_reference`; null when unset. */
  fo_reference?: string | null
  /** Factory purchase cost per unit (variant metadata.qb_purchase_cost), attached
   *  by the route to value aging stock. null when unknown. */
  unit_cost?: number | null
}

export interface ItemResidual {
  inventory_item_id: string
  sku: string
  description: string | null
  surplus: number
  manual_lots: ManualLotInput[]
}

export interface TimelineResult {
  rows: TimelineRow[]
  residuals: ItemResidual[]
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
/** Length of the intersection of [a0,a1) and [b0,b1). */
const overlap = (a0: number, a1: number, b0: number, b1: number) =>
  Math.max(0, Math.min(a1, b1) - Math.max(a0, b0))

export function buildTimeline(
  receiptsByItem: Map<string, ReceiptInput[]>,
  stockByItem: Map<string, StockInput>,
  manualLotsByItem: Map<string, ManualLotInput[]>
): TimelineResult {
  const rows: TimelineRow[] = []
  const residuals: ItemResidual[] = []
  const seenItems = new Set<string>()

  const emitSurplus = (itemId: string, sku: string, desc: string | null, surplus: number) => {
    const lots = manualLotsByItem.get(itemId) ?? []
    let remaining = surplus
    for (const lot of lots) {
      const alloc = Math.min(lot.qty, Math.max(0, remaining))
      remaining -= alloc
      if (alloc <= 0) continue
      rows.push({
        key: `manual:${lot.id}`,
        kind: "manual",
        inventory_item_id: itemId,
        fo_number: lot.fo_number,
        fo_id: null,
        receipt_number: null,
        sku,
        description: desc,
        qty_received: alloc,
        received_at: lot.received_at,
        miami_qty: 0,
        in_transit_qty: 0,
        current_qty: alloc,
        manual_lot_id: lot.id,
      })
    }
    if (remaining > 0) {
      rows.push(makeResidual("unattributed", itemId, sku, desc, remaining))
    }
    if (surplus > 0 || lots.length > 0) {
      residuals.push({ inventory_item_id: itemId, sku, description: desc, surplus, manual_lots: lots })
    }
  }

  for (const [itemId, unsorted] of receiptsByItem) {
    seenItems.add(itemId)

    const receipts = [...unsorted].sort((a, b) => {
      const t = a.received_at.localeCompare(b.received_at)
      return t !== 0 ? t : a.line_id.localeCompare(b.line_id)
    })

    const totalReceived = receipts.reduce((s, r) => s + r.qty_received, 0)
    const stockRow = stockByItem.get(itemId)
    const stock = stockRow?.stocked ?? 0
    const inTransit = Math.max(0, stockRow?.in_transit ?? 0)

    // Physical units still in China (what actually ages). Can go negative when
    // more has been shipped/adjusted out than the pool holds (surfaced as deficit).
    const physicalChina = stock - inTransit

    // Two cut points on the [0, totalReceived) cumulative lot axis. Miami first
    // (units that completed the journey = totalReceived − stocked), then in-transit.
    // Both clamped to the axis; anything the axis can't hold is a residual below.
    const miamiCut = clamp(totalReceived - stock, 0, totalReceived)
    const transitCut = clamp(miamiCut + inTransit, miamiCut, totalReceived)

    let cursor = 0
    let attributedChina = 0
    for (const r of receipts) {
      const start = cursor
      const end = cursor + r.qty_received
      cursor = end
      const lotMiami = overlap(start, end, 0, miamiCut)
      const lotTransit = overlap(start, end, miamiCut, transitCut)
      const lotChina = r.qty_received - lotMiami - lotTransit
      attributedChina += lotChina
      rows.push({
        key: r.line_id,
        kind: "receipt",
        inventory_item_id: itemId,
        fo_number: r.fo_number,
        fo_id: r.fo_id,
        receipt_number: r.receipt_number,
        sku: r.sku,
        description: r.description,
        qty_received: r.qty_received,
        received_at: r.received_at,
        miami_qty: lotMiami,
        in_transit_qty: lotTransit,
        current_qty: lotChina,
      })
    }

    const sku = receipts[0]?.sku ?? stockRow?.sku ?? ""
    const description = receipts[0]?.description ?? stockRow?.description ?? null

    // Reconcile the En-China total to physical stock. Lots attributed
    // `attributedChina`; the difference is honest surplus (adjustments) or deficit.
    const residualChina = physicalChina - attributedChina
    if (residualChina > 0) {
      emitSurplus(itemId, sku, description, residualChina)
    } else if (residualChina < 0) {
      rows.push(makeResidual("deficit", itemId, sku, description, residualChina))
    } else if ((manualLotsByItem.get(itemId)?.length ?? 0) > 0) {
      // No surplus, but stale manual lots exist — expose for editing/clearing.
      emitSurplus(itemId, sku, description, 0)
    }
  }

  // Items with live China presence but NO receipt history at all.
  for (const [itemId, s] of stockByItem) {
    if (seenItems.has(itemId)) continue
    const physicalChina = s.stocked - Math.max(0, s.in_transit)
    if (physicalChina > 0) {
      emitSurplus(itemId, s.sku, s.description, physicalChina)
    } else if (physicalChina < 0) {
      rows.push(makeResidual("deficit", itemId, s.sku, s.description, physicalChina))
    } else if ((manualLotsByItem.get(itemId)?.length ?? 0) > 0) {
      emitSurplus(itemId, s.sku, s.description, 0)
    }
  }

  return { rows, residuals }
}

function makeResidual(
  kind: TimelineRowKind,
  itemId: string,
  sku: string,
  description: string | null,
  qty: number
): TimelineRow {
  return {
    key: `${kind}:${itemId}`,
    kind,
    inventory_item_id: itemId,
    fo_number: null,
    fo_id: null,
    receipt_number: null,
    sku,
    description,
    qty_received: kind === "unattributed" ? qty : 0,
    received_at: null,
    miami_qty: 0,
    in_transit_qty: 0,
    current_qty: qty,
  }
}

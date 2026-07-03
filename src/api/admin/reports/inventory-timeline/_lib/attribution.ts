/**
 * FIFO attribution for the Inventory Timeline (China warehouse aging) report.
 *
 * China stock is a single fungible pool per `inventory_item_id` — the schema has
 * NO record-level lineage tying an outbound transfer/shipment back to a specific
 * Factory Order receipt. To render "one row per received lot" with a per-row
 * SHIPPED and CURRENT quantity, we attribute the live on-hand pool across the
 * receipt lots using FIFO (oldest lot consumed first).
 *
 * Invariant: for every inventory_item_id, the sum of `current_qty` across the
 * rows it produces exactly equals the live `stocked_quantity` at China. When the
 * receipt history can't fully explain live stock (over-received imports or
 * negative stock from China adjustments), the residual is surfaced as an explicit
 * synthetic row instead of being silently smeared or clamped.
 *
 * Manual lots: stock that came from an inventory adjustment has no FO receipt, so
 * it lands in the positive "unattributed" residual. The operator can layer manual
 * lots over that surplus (an FO + received date + qty, split as needed) purely for
 * aging control — the underlying stock stays unattributed; a manual lot just
 * carves a labelled, dated slice out of the surplus so it can age like a receipt.
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
  shipped_qty: number
  current_qty: number
  manual_lot_id?: string
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
        shipped_qty: 0,
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
    const stock = stockByItem.get(itemId)?.stocked ?? 0

    // How many units have left China (shipped + adjusted + shrinkage). When stock
    // exceeds everything received, there's nothing to consume (clamp to 0); the
    // surplus is attributed to manual lots / unattributed below.
    let remaining = Math.max(0, totalReceived - stock)

    for (const r of receipts) {
      const take = Math.min(r.qty_received, remaining)
      remaining -= take
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
        shipped_qty: take,
        current_qty: r.qty_received - take,
      })
    }

    const sku = receipts[0]?.sku ?? stockByItem.get(itemId)?.sku ?? ""
    const description = receipts[0]?.description ?? stockByItem.get(itemId)?.description ?? null

    if (stock > totalReceived) {
      emitSurplus(itemId, sku, description, stock - totalReceived)
    } else if (stock < 0) {
      // Negative China stock (allowed by design). All receipts read fully
      // consumed above; surface the deficit as its own row, never spread it.
      rows.push(makeResidual("deficit", itemId, sku, description, stock))
    } else if ((manualLotsByItem.get(itemId)?.length ?? 0) > 0) {
      // No surplus, but stale manual lots exist — expose for editing/clearing.
      emitSurplus(itemId, sku, description, 0)
    }
  }

  // Items with live China stock but NO receipt history at all.
  for (const [itemId, s] of stockByItem) {
    if (seenItems.has(itemId)) continue
    if (s.stocked > 0) {
      emitSurplus(itemId, s.sku, s.description, s.stocked)
    } else if (s.stocked < 0) {
      rows.push(makeResidual("deficit", itemId, s.sku, s.description, s.stocked))
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
    shipped_qty: 0,
    current_qty: qty,
  }
}

import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { randomUUID } from "crypto"

/**
 * POST /admin/reports/inventory-timeline/assignment
 *
 * Persists manual FO lot assignments layered over an item's unattributed China
 * stock (for aging control — see ../_lib/attribution.ts). Stored on the
 * inventory item's metadata under `china_manual_lots`. Sending an empty `lots`
 * array clears the assignment.
 *
 * Body: { inventory_item_id: string, lots: Array<{ fo_number, received_at?, qty, note? }> }
 */

interface IncomingLot {
  id?: unknown
  fo_number?: unknown
  received_at?: unknown
  qty?: unknown
  note?: unknown
}

interface StoredLot {
  id: string
  fo_number: string
  received_at: string | null
  qty: number
  note: string | null
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const pg = req.scope.resolve("__pg_connection__") as {
    raw: (sql: string, bindings?: unknown[]) => Promise<{ rowCount?: number }>
  }

  const body = (req.body ?? {}) as { inventory_item_id?: unknown; lots?: unknown }
  const inventoryItemId = typeof body.inventory_item_id === "string" ? body.inventory_item_id.trim() : ""
  if (!inventoryItemId) {
    return res.status(400).json({ error: "inventory_item_id is required" })
  }
  if (!Array.isArray(body.lots)) {
    return res.status(400).json({ error: "lots must be an array" })
  }

  const lots: StoredLot[] = []
  for (const raw of body.lots as IncomingLot[]) {
    const fo = typeof raw.fo_number === "string" ? raw.fo_number.trim() : ""
    const qty = Math.round(Number(raw.qty ?? 0))
    if (!fo || !Number.isFinite(qty) || qty <= 0) {
      return res.status(400).json({ error: "each lot needs a non-empty fo_number and qty > 0" })
    }
    let receivedAt: string | null = null
    if (raw.received_at != null && raw.received_at !== "") {
      const d = new Date(String(raw.received_at))
      if (Number.isNaN(d.getTime())) {
        return res.status(400).json({ error: `invalid received_at for FO ${fo}` })
      }
      receivedAt = d.toISOString()
    }
    lots.push({
      id: typeof raw.id === "string" && raw.id ? raw.id : `mlot_${randomUUID()}`,
      fo_number: fo,
      received_at: receivedAt,
      qty,
      note: typeof raw.note === "string" && raw.note.trim() ? raw.note.trim() : null,
    })
  }

  try {
    // `|| jsonb_build_object(...)` replaces the key wholesale (jsonb concat
    // overwrites top-level keys) — avoids the Medusa deep-merge array gotcha.
    const result = await pg.raw(
      `UPDATE inventory_item
         SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('china_manual_lots', ?::jsonb),
             updated_at = NOW()
       WHERE id = ? AND deleted_at IS NULL`,
      [JSON.stringify(lots), inventoryItemId]
    )

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "inventory item not found" })
    }

    return res.json({ inventory_item_id: inventoryItemId, lots })
  } catch (err) {
    console.error("[reports/inventory-timeline/assignment]", err)
    return res.status(500).json({ error: "Failed to save assignment" })
  }
}

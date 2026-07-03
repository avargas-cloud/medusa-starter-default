import { ExecArgs } from "@medusajs/framework/types"
import { CHINA_LOC } from "../../lib/locations"
import {
  buildTimeline,
  type ReceiptInput,
  type StockInput,
  type ManualLotInput,
} from "../../api/admin/reports/inventory-timeline/_lib/attribution"

/**
 * Verifies the Inventory Timeline FIFO attribution against live prod data:
 *   - reconciliation invariant: Σ(current_qty) per inventory_item_id === live China stock
 *   - no negative shipped, no shipped > qty_received on any receipt row
 *   - prints a summary (rows, residuals, over-60 lots)
 *
 * Run: env DATABASE_URL=... npx medusa exec ./src/scripts/verify/verify-inventory-timeline.ts
 */
export default async function verify({ container }: ExecArgs) {
  const pg = container.resolve("__pg_connection__") as {
    raw: (sql: string) => Promise<{ rows: Record<string, unknown>[] }>
  }

  const receiptRes = await pg.raw(`
    SELECT forl.id AS line_id, forl.inventory_item_id AS inventory_item_id,
           forl.sku_snapshot AS sku, forl.description_snapshot AS description,
           forl.qty_received_now AS qty_received, fore.received_at AS received_at,
           fore.number AS receipt_number, fo.number AS fo_number, fo.id AS fo_id
    FROM factory_order_receipt_line forl
    JOIN factory_order_receipt fore ON fore.id = forl.factory_order_receipt_id
    JOIN factory_order fo ON fo.id = forl.factory_order_id
    WHERE forl.deleted_at IS NULL AND fore.deleted_at IS NULL
      AND fore.status = 'applied' AND COALESCE(forl.qty_received_now, 0) <> 0
    ORDER BY forl.inventory_item_id, fore.received_at ASC, forl.id ASC
  `)

  const stockRes = await pg.raw(`
    SELECT il.inventory_item_id AS inventory_item_id, il.stocked_quantity AS stocked,
           pv.sku AS sku, COALESCE(NULLIF(TRIM(pv.title), ''), pv.sku) AS description
    FROM inventory_level il
    LEFT JOIN product_variant_inventory_item pvii ON pvii.inventory_item_id = il.inventory_item_id
    LEFT JOIN product_variant pv ON pv.id = pvii.variant_id AND pv.deleted_at IS NULL
    WHERE il.location_id = '${CHINA_LOC}'
  `)

  const receiptsByItem = new Map<string, ReceiptInput[]>()
  for (const r of receiptRes.rows) {
    const itemId = String(r.inventory_item_id ?? "")
    if (!itemId || !r.received_at) continue
    const list = receiptsByItem.get(itemId) ?? []
    list.push({
      line_id: String(r.line_id),
      fo_number: r.fo_number != null ? String(r.fo_number) : null,
      fo_id: r.fo_id != null ? String(r.fo_id) : null,
      receipt_number: r.receipt_number != null ? String(r.receipt_number) : null,
      sku: String(r.sku ?? ""),
      description: r.description != null ? String(r.description) : null,
      qty_received: Number(r.qty_received ?? 0),
      received_at: new Date(r.received_at as string).toISOString(),
    })
    receiptsByItem.set(itemId, list)
  }

  const stockByItem = new Map<string, StockInput>()
  for (const r of stockRes.rows) {
    const itemId = String(r.inventory_item_id ?? "")
    if (!itemId) continue
    stockByItem.set(itemId, {
      inventory_item_id: itemId,
      sku: String(r.sku ?? ""),
      description: r.description != null ? String(r.description) : null,
      stocked: Number(r.stocked ?? 0),
    })
  }

  // Load real manual lots so the invariant test covers the manual-attribution path.
  const manualRes = await pg.raw(`
    SELECT id AS inventory_item_id, metadata->'china_manual_lots' AS lots
    FROM inventory_item
    WHERE deleted_at IS NULL AND metadata->'china_manual_lots' IS NOT NULL
  `)
  const manualLotsByItem = new Map<string, ManualLotInput[]>()
  for (const r of manualRes.rows) {
    const itemId = String(r.inventory_item_id ?? "")
    if (!itemId || !Array.isArray(r.lots)) continue
    const lots = (r.lots as Record<string, unknown>[])
      .map((l) => ({
        id: String(l.id ?? ""),
        fo_number: String(l.fo_number ?? "").trim(),
        received_at: l.received_at != null ? String(l.received_at) : null,
        qty: Math.max(0, Math.round(Number(l.qty ?? 0))),
        note: l.note != null ? String(l.note) : null,
      }))
      .filter((l) => l.id && l.fo_number && l.qty > 0)
    if (lots.length) manualLotsByItem.set(itemId, lots)
  }

  const { rows } = buildTimeline(receiptsByItem, stockByItem, manualLotsByItem)

  // Invariant 1: Σ current per item === live stock (for every item that appears)
  const currentByItem = new Map<string, number>()
  for (const row of rows) {
    currentByItem.set(row.inventory_item_id, (currentByItem.get(row.inventory_item_id) ?? 0) + row.current_qty)
  }
  const allItems = new Set<string>([...receiptsByItem.keys(), ...stockByItem.keys()])
  let mismatches = 0
  for (const itemId of allItems) {
    const stock = stockByItem.get(itemId)?.stocked ?? 0
    const attributed = currentByItem.get(itemId) ?? 0
    if (attributed !== stock) {
      mismatches++
      console.error(`  ✗ RECONCILE FAIL ${itemId}: Σcurrent=${attributed} vs stock=${stock}`)
    }
  }

  // Invariant 2: per receipt row, 0 <= shipped <= qty_received, current >= 0
  let badRows = 0
  for (const row of rows) {
    if (row.kind !== "receipt") continue
    if (row.shipped_qty < 0 || row.shipped_qty > row.qty_received || row.current_qty < 0) {
      badRows++
      console.error(`  ✗ BAD ROW ${row.sku} ${row.fo_number}: recv=${row.qty_received} ship=${row.shipped_qty} cur=${row.current_qty}`)
    }
  }

  const receiptRows = rows.filter((r) => r.kind === "receipt")
  const unattributed = rows.filter((r) => r.kind === "unattributed")
  const deficit = rows.filter((r) => r.kind === "deficit")
  const now = Date.now()
  const over60 = receiptRows.filter((r) => {
    if (!r.received_at || r.current_qty <= 0) return false
    return Math.floor((now - new Date(r.received_at).getTime()) / 86_400_000) > 60
  })
  const oldestOpen = receiptRows
    .filter((r) => r.current_qty > 0 && r.received_at)
    .map((r) => ({ sku: r.sku, fo: r.fo_number, days: Math.floor((now - new Date(r.received_at as string).getTime()) / 86_400_000), qty: r.current_qty }))
    .sort((a, b) => b.days - a.days)
    .slice(0, 5)

  console.log("\n=== Inventory Timeline verification ===")
  console.log(`receipt rows:        ${receiptRows.length}`)
  console.log(`unattributed rows:   ${unattributed.length}`)
  console.log(`deficit rows:        ${deficit.length}`)
  console.log(`reconcile mismatches:${mismatches}  (must be 0)`)
  console.log(`bad receipt rows:    ${badRows}  (must be 0)`)
  console.log(`lots over 60 days w/ current>0: ${over60.length}`)
  console.log("oldest open lots (top 5):")
  for (const o of oldestOpen) console.log(`  ${o.sku} ${o.fo} — ${o.days}d, ${o.qty} units`)
  console.log(mismatches === 0 && badRows === 0 ? "\n✓ ALL INVARIANTS HOLD" : "\n✗ INVARIANT FAILURES — see above")
}

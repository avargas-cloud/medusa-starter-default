import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { CHINA_LOC } from "../../../../lib/locations"
import {
  buildTimeline,
  type ReceiptInput,
  type StockInput,
  type ManualLotInput,
} from "./_lib/attribution"

/**
 * GET /admin/reports/inventory-timeline
 *
 * Aging report for stock sitting in the China agent's warehouse. One row per
 * Factory Order receipt lot (plus synthetic residual rows when live stock can't
 * be explained by receipt history). SHIPPED / CURRENT quantities are attributed
 * across lots by FIFO — see ./_lib/attribution.ts for the reconciliation model.
 *
 * The 60-day SLA alarm (a lot older than 60 days that still has CURRENT > 0) is
 * computed client-side from `received_at` so it always reflects "today".
 */

// Resolve the purchase description for an inventory item. The real purchase
// description lives in variant metadata.qb_purchase_desc (the long text shown on
// POs); variant.title is just "Default" for single-variant products, so we fall
// back to the PRODUCT title (the human name) then the SKU. LATERAL … LIMIT 1
// keeps a one-to-one row shape even if an item links to more than one variant.
const DESC_LATERAL = (skuCol: string) => `
  COALESCE(
    NULLIF(TRIM(v.purchase_description), ''),
    NULLIF(TRIM(v.title), ''),
    ${skuCol}
  ) AS description`
const DESC_JOIN = (itemCol: string) => `
  LEFT JOIN LATERAL (
    SELECT
      pv.metadata->>'qb_purchase_desc' AS purchase_description,
      p.title                          AS title,
      pv.sku                           AS sku
    FROM product_variant_inventory_item pvii
    JOIN product_variant pv ON pv.id = pvii.variant_id AND pv.deleted_at IS NULL
    JOIN product p ON p.id = pv.product_id AND p.deleted_at IS NULL
    WHERE pvii.inventory_item_id = ${itemCol}
    LIMIT 1
  ) v ON TRUE`

// Applied receipts only = the exact set of lots whose units are actually in the
// China pool. `pending`/`error` haven't moved stock; `voided` reversed it.
const RECEIPTS_SQL = `
  SELECT
    forl.id                    AS line_id,
    forl.inventory_item_id     AS inventory_item_id,
    forl.sku_snapshot          AS sku,
    forl.qty_received_now      AS qty_received,
    fore.received_at           AS received_at,
    fore.number                AS receipt_number,
    fo.number                  AS fo_number,
    fo.id                      AS fo_id,
    ${DESC_LATERAL("forl.sku_snapshot")}
  FROM factory_order_receipt_line forl
  JOIN factory_order_receipt fore ON fore.id = forl.factory_order_receipt_id
  JOIN factory_order fo           ON fo.id = forl.factory_order_id
  ${DESC_JOIN("forl.inventory_item_id")}
  WHERE forl.deleted_at IS NULL
    AND fore.deleted_at IS NULL
    AND fore.status = 'applied'
    AND COALESCE(forl.qty_received_now, 0) <> 0
  ORDER BY forl.inventory_item_id, fore.received_at ASC, forl.id ASC
`

const CHINA_STOCK_SQL = `
  SELECT
    il.inventory_item_id       AS inventory_item_id,
    il.stocked_quantity        AS stocked,
    v.sku                      AS sku,
    ${DESC_LATERAL("v.sku")}
  FROM inventory_level il
  ${DESC_JOIN("il.inventory_item_id")}
  WHERE il.location_id = '${CHINA_LOC}'
`

// Manual FO assignments layered over unattributed stock, stored on the item's
// metadata. NOTE: the jsonb `?` existence operator collides with knex bindings —
// use `-> 'key' IS NOT NULL` instead.
const MANUAL_LOTS_SQL = `
  SELECT id AS inventory_item_id, metadata->'china_manual_lots' AS lots
  FROM inventory_item
  WHERE deleted_at IS NULL AND metadata->'china_manual_lots' IS NOT NULL
`

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const pg = req.scope.resolve("__pg_connection__") as {
    raw: (sql: string) => Promise<{ rows: Record<string, unknown>[] }>
  }

  try {
    const [receiptRes, stockRes, manualRes] = await Promise.all([
      pg.raw(RECEIPTS_SQL),
      pg.raw(CHINA_STOCK_SQL),
      pg.raw(MANUAL_LOTS_SQL),
    ])

    const receiptsByItem = new Map<string, ReceiptInput[]>()
    for (const r of receiptRes.rows) {
      const itemId = String(r.inventory_item_id ?? "")
      if (!itemId) continue
      const received = r.received_at ? new Date(r.received_at as string).toISOString() : ""
      if (!received) continue
      const list = receiptsByItem.get(itemId) ?? []
      list.push({
        line_id: String(r.line_id),
        fo_number: r.fo_number != null ? String(r.fo_number) : null,
        fo_id: r.fo_id != null ? String(r.fo_id) : null,
        receipt_number: r.receipt_number != null ? String(r.receipt_number) : null,
        sku: String(r.sku ?? ""),
        description: r.description != null ? String(r.description) : null,
        qty_received: Number(r.qty_received ?? 0),
        received_at: received,
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

    const manualLotsByItem = new Map<string, ManualLotInput[]>()
    for (const r of manualRes.rows) {
      const itemId = String(r.inventory_item_id ?? "")
      if (!itemId || !Array.isArray(r.lots)) continue
      const lots: ManualLotInput[] = (r.lots as unknown[])
        .map((raw) => {
          const l = raw as Record<string, unknown>
          return {
            id: String(l.id ?? ""),
            fo_number: String(l.fo_number ?? "").trim(),
            received_at: l.received_at != null ? String(l.received_at) : null,
            qty: Math.max(0, Math.round(Number(l.qty ?? 0))),
            note: l.note != null ? String(l.note) : null,
          }
        })
        .filter((l) => l.id && l.fo_number && l.qty > 0)
      if (lots.length) manualLotsByItem.set(itemId, lots)
    }

    const { rows, residuals } = buildTimeline(receiptsByItem, stockByItem, manualLotsByItem)

    return res.json({
      rows,
      residuals,
      generated_at: new Date().toISOString(),
    })
  } catch (err) {
    console.error("[reports/inventory-timeline]", err)
    return res.status(500).json({ error: "Failed to build inventory timeline" })
  }
}

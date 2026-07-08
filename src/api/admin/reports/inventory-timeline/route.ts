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

// Units on shipped-but-not-yet-received transfers (origin China). These left the
// warehouse physically but are still carried in `stocked_quantity` (stock only
// drops at RECEIVE). Keyed to inventory_item_id via the variant→item link (1:1).
// Doubles as the "active in transit" set for the closed-product filter below.
const IN_TRANSIT_CTE = `
  in_transit AS (
    SELECT
      pvii.inventory_item_id AS inventory_item_id,
      SUM(GREATEST(0, itl.qty - COALESCE(itl.qty_received, 0)))::int AS in_transit_qty
    FROM inventory_transfer_line itl
    JOIN inventory_transfer it
      ON it.id = itl.transfer_id AND it.deleted_at IS NULL
    JOIN product_variant_inventory_item pvii
      ON pvii.variant_id = itl.product_variant_id AND pvii.deleted_at IS NULL
    WHERE itl.deleted_at IS NULL
      AND it.status = 'shipped'
      AND it.origin_country = 'CN'
    GROUP BY pvii.inventory_item_id
    HAVING SUM(GREATEST(0, itl.qty - COALESCE(itl.qty_received, 0))) > 0
  )`

// Only items still relevant to an AGING report: something physically in China
// (stocked <> 0, incl. negative deficits) OR units currently in transit out of
// China. Fully-received products (stocked = 0, nothing in transit) drop out
// automatically — "closed" with zero bookkeeping, so history never has to be
// recomputed. This bounds the receipt scan to active inventory (not all history).
const ACTIVE_ITEMS_CTE = `
  active_items AS (
    SELECT inventory_item_id FROM inventory_level
      WHERE location_id = '${CHINA_LOC}'
        AND deleted_at IS NULL
        AND stocked_quantity <> 0
    UNION
    SELECT inventory_item_id FROM in_transit
  )`

// Applied receipts only = the exact set of lots whose units are actually in the
// China pool. `pending`/`error` haven't moved stock; `voided` reversed it.
const RECEIPTS_SQL = `
  WITH ${IN_TRANSIT_CTE},
  ${ACTIVE_ITEMS_CTE}
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
  JOIN active_items ai            ON ai.inventory_item_id = forl.inventory_item_id
  ${DESC_JOIN("forl.inventory_item_id")}
  WHERE forl.deleted_at IS NULL
    AND fore.deleted_at IS NULL
    AND fore.status = 'applied'
    AND COALESCE(forl.qty_received_now, 0) <> 0
  ORDER BY forl.inventory_item_id, fore.received_at ASC, forl.id ASC
`

const CHINA_STOCK_SQL = `
  WITH ${IN_TRANSIT_CTE}
  SELECT
    il.inventory_item_id       AS inventory_item_id,
    il.stocked_quantity        AS stocked,
    COALESCE(itr.in_transit_qty, 0) AS in_transit,
    v.sku                      AS sku,
    ${DESC_LATERAL("v.sku")}
  FROM inventory_level il
  LEFT JOIN in_transit itr ON itr.inventory_item_id = il.inventory_item_id
  ${DESC_JOIN("il.inventory_item_id")}
  WHERE il.location_id = '${CHINA_LOC}'
    AND (il.stocked_quantity <> 0 OR itr.in_transit_qty IS NOT NULL)
`

// Manual FO assignments layered over unattributed stock, stored on the item's
// metadata. NOTE: the jsonb `?` existence operator collides with knex bindings —
// use `-> 'key' IS NOT NULL` instead.
const MANUAL_LOTS_SQL = `
  SELECT id AS inventory_item_id, metadata->'china_manual_lots' AS lots
  FROM inventory_item
  WHERE deleted_at IS NULL AND metadata->'china_manual_lots' IS NOT NULL
`

// Operator's Excel FO number(s) per item — display-only cross-reference shown in
// the "FO Ref" column next to the system FIFO-attributed FO.
const FO_REFERENCE_SQL = `
  SELECT id AS inventory_item_id, metadata->>'china_fo_reference' AS fo_reference
  FROM inventory_item
  WHERE deleted_at IS NULL AND NULLIF(metadata->>'china_fo_reference', '') IS NOT NULL
`

// Factory purchase cost per item (variant metadata.qb_purchase_cost — the China
// valuation basis, same as China Finance). Used to value over-SLA aging stock.
const COST_SQL = `
  SELECT DISTINCT ON (pvii.inventory_item_id)
         pvii.inventory_item_id,
         NULLIF(pv.metadata->>'qb_purchase_cost', '')::numeric AS unit_cost
  FROM product_variant_inventory_item pvii
  JOIN product_variant pv ON pv.id = pvii.variant_id AND pv.deleted_at IS NULL
  WHERE pvii.deleted_at IS NULL AND NULLIF(pv.metadata->>'qb_purchase_cost', '') IS NOT NULL
  ORDER BY pvii.inventory_item_id, pv.created_at ASC
`

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const pg = req.scope.resolve("__pg_connection__") as {
    raw: (sql: string) => Promise<{ rows: Record<string, unknown>[] }>
  }

  try {
    const [receiptRes, stockRes, manualRes, refRes, costRes] = await Promise.all([
      pg.raw(RECEIPTS_SQL),
      pg.raw(CHINA_STOCK_SQL),
      pg.raw(MANUAL_LOTS_SQL),
      pg.raw(FO_REFERENCE_SQL),
      pg.raw(COST_SQL),
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
        in_transit: Number(r.in_transit ?? 0),
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

    const foRefByItem = new Map<string, string>()
    for (const r of refRes.rows) {
      const itemId = String(r.inventory_item_id ?? "")
      const ref = r.fo_reference != null ? String(r.fo_reference).trim() : ""
      if (itemId && ref) foRefByItem.set(itemId, ref)
    }

    const costByItem = new Map<string, number>()
    for (const r of costRes.rows) {
      const itemId = String(r.inventory_item_id ?? "")
      const cost = r.unit_cost != null ? Number(r.unit_cost) : NaN
      if (itemId && Number.isFinite(cost)) costByItem.set(itemId, cost)
    }

    const { rows, residuals } = buildTimeline(receiptsByItem, stockByItem, manualLotsByItem)
    const rowsWithRef = rows.map((row) => ({
      ...row,
      fo_reference: foRefByItem.get(row.inventory_item_id) ?? null,
      unit_cost: costByItem.get(row.inventory_item_id) ?? null,
    }))

    return res.json({
      rows: rowsWithRef,
      residuals,
      generated_at: new Date().toISOString(),
    })
  } catch (err) {
    console.error("[reports/inventory-timeline]", err)
    return res.status(500).json({ error: "Failed to build inventory timeline" })
  }
}

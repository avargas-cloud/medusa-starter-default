import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"

const CHINA_SLOC = 'sloc_01KQ14C1CFX30EDD722BF87HDM'
const ROOT_CAT   = 'pcat_01KGAD1KQV29RKZZHEZ4N88B8H'

// Inventory value = stocked - reserved.
//
// Earlier this report subtracted "pending transfers that had a bill linked"
// (EXISTS china_finance_bill) — transfers without a bill were ignored, so
// stock already committed to an outbound transfer kept inflating the value.
// `inventory_level.reserved_quantity` already reflects EVERY active reservation
// at the location (transfers, draft orders, etc.) so we use it directly and
// drop the bill filter. Bills are surfaced separately as POs-without-bills.
const REPORT_CTES = `
  tier1 AS (
    SELECT DISTINCT ON (pcp.product_id)
      pcp.product_id,
      COALESCE(
        CASE WHEN pc.parent_category_id = '${ROOT_CAT}' THEN pc.name END,
        CASE WHEN pc2.parent_category_id = '${ROOT_CAT}' THEN pc2.name END,
        'Uncategorized'
      ) AS category
    FROM product_category_product pcp
    JOIN product_category pc ON pc.id = pcp.product_category_id
    LEFT JOIN product_category pc2 ON pc2.id = pc.parent_category_id
    ORDER BY pcp.product_id, pc.name
  )
`

const FACTORY_COST = `COALESCE(
  (pv.metadata->>'qb_purchase_cost')::numeric,
  (pv.metadata->>'qb_avg_cost')::numeric,
  0
)`

const LANDED_COST = `COALESCE(
  (pv.metadata->>'qb_avg_cost')::numeric,
  0
)`

const CHINA_AVAILABLE_QTY = `GREATEST(
  0,
  il.stocked_quantity - COALESCE(il.reserved_quantity, 0)
)`

const BASE_JOINS = `
  FROM inventory_level il
  JOIN inventory_item ii ON ii.id = il.inventory_item_id
  JOIN product_variant_inventory_item pvii ON pvii.inventory_item_id = ii.id
  JOIN product_variant pv ON pv.id = pvii.variant_id AND pv.deleted_at IS NULL
  JOIN product p ON p.id = pv.product_id AND p.deleted_at IS NULL
  LEFT JOIN tier1 t1 ON t1.product_id = p.id
  WHERE il.location_id = '${CHINA_SLOC}' AND il.stocked_quantity > 0
`

// POs whose linked inventory transfer is active (origin CN, status
// confirmed|shipped) but which have NO matching china_finance_bill row.
// The match logic mirrors the previous active_transfer EXISTS clause:
// bill matches by po_number, po_ref_number, or via vendor_bill linkage.
const POS_WITHOUT_BILLS_SQL = `
  SELECT DISTINCT
    po.number                              AS po_number,
    po.qb_purchase_order_txn_number        AS qb_po_number,
    it.number                              AS transfer_number,
    COALESCE(NULLIF(TRIM(po.vendor_name_snapshot), ''), 'Unknown') AS vendor_name
  FROM inventory_transfer it
  JOIN purchase_order po
    ON po.id = it.linked_purchase_order_id
   AND po.deleted_at IS NULL
  WHERE it.deleted_at IS NULL
    AND it.origin_country = 'CN'
    AND it.status IN ('confirmed', 'shipped')
    AND NOT EXISTS (
      SELECT 1
      FROM china_finance_bill cfb
      WHERE cfb.po_number     = po.qb_purchase_order_txn_number
         OR cfb.po_ref_number = po.number
         OR cfb.vendor_bill_id IN (
           SELECT vb.id
           FROM vendor_bill vb
           WHERE vb.purchase_order_id = po.id
             AND vb.deleted_at IS NULL
         )
    )
  ORDER BY po.number ASC
`

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const pg = req.scope.resolve("__pg_connection__") as any

  try {
    const [byFactoryRes, byCategoryRes, posWithoutBillsRes] = await Promise.all([
      pg.raw(
        `WITH ${REPORT_CTES}
         SELECT
           COALESCE(NULLIF(TRIM(p.metadata->>'qb_vendor_full_name'),''), 'Unknown') AS label,
           COUNT(DISTINCT pv.id)::int                                                AS variants,
           SUM(${CHINA_AVAILABLE_QTY})::int                                          AS qty,
           ROUND(SUM(${CHINA_AVAILABLE_QTY} * ${FACTORY_COST})::numeric, 2)           AS value,
           ROUND(SUM(${CHINA_AVAILABLE_QTY} * ${LANDED_COST})::numeric, 2)           AS landed_value
         ${BASE_JOINS}
         GROUP BY 1
         HAVING SUM(${CHINA_AVAILABLE_QTY}) > 0
         ORDER BY value DESC, qty DESC`
      ),
      pg.raw(
        `WITH ${REPORT_CTES}
         SELECT
           COALESCE(t1.category, 'Uncategorized')                                   AS label,
           COUNT(DISTINCT pv.id)::int                                                AS variants,
           SUM(${CHINA_AVAILABLE_QTY})::int                                          AS qty,
           ROUND(SUM(${CHINA_AVAILABLE_QTY} * ${FACTORY_COST})::numeric, 2)          AS value,
           ROUND(SUM(${CHINA_AVAILABLE_QTY} * ${LANDED_COST})::numeric, 2)           AS landed_value
         ${BASE_JOINS}
         GROUP BY 1
         HAVING SUM(${CHINA_AVAILABLE_QTY}) > 0
         ORDER BY value DESC, qty DESC`
      ),
      pg.raw(POS_WITHOUT_BILLS_SQL),
    ])

    const mapRow = (r: any) => ({
      label:        r.label as string,
      variants:     Number(r.variants),
      qty:          Number(r.qty),
      value:        Number(r.value),
      landed_value: Number(r.landed_value),
    })

    const allRows = (byFactoryRes.rows as any[]).map(mapRow)
    const totalQty          = allRows.reduce((s, r) => s + r.qty, 0)
    const totalValue        = allRows.reduce((s, r) => s + r.value, 0)
    const totalLandedValue  = allRows.reduce((s, r) => s + r.landed_value, 0)

    const posWithoutBills = (posWithoutBillsRes.rows as any[]).map((r) => ({
      po_number:       String(r.po_number ?? ''),
      qb_po_number:    r.qb_po_number != null ? String(r.qb_po_number) : null,
      transfer_number: r.transfer_number != null ? String(r.transfer_number) : null,
      vendor_name:     String(r.vendor_name ?? 'Unknown'),
    }))

    return res.json({
      by_factory:  allRows,
      by_category: (byCategoryRes.rows as any[]).map(mapRow),
      totals: {
        variants:     allRows.length,
        qty:          totalQty,
        value:        Math.round(totalValue * 100) / 100,
        landed_value: Math.round(totalLandedValue * 100) / 100,
      },
      pos_without_bills: posWithoutBills,
    })
  } catch (err) {
    console.error("[factory-orders/china-inventory]", err)
    return res.status(500).json({ error: "Failed to fetch China inventory" })
  }
}

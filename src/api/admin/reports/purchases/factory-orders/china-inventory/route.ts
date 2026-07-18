import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"

import { avgCostDollars, purchaseCostDollars } from "../../../../../../lib/cost/cost-sql"
import { TIER1_CTE } from "../../../_lib/category-tier1"

const CHINA_SLOC = 'sloc_01KQ14C1CFX30EDD722BF87HDM'

// Inventory value = stocked - reserved.
//
// Earlier this report subtracted "pending transfers that had a bill linked"
// (EXISTS china_finance_bill) — transfers without a bill were ignored, so
// stock already committed to an outbound transfer kept inflating the value.
// `inventory_level.reserved_quantity` already reflects EVERY active reservation
// at the location (transfers, draft orders, etc.) so we use it directly and
// drop the bill filter. Bills are surfaced separately as POs-without-bills.

const FACTORY_COST = `COALESCE(${purchaseCostDollars("pv")}, 0)`

const LANDED_COST = `COALESCE(${avgCostDollars("pv")}, 0)`

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
  LEFT JOIN product_tier1 t1 ON t1.product_id = p.id
  WHERE il.location_id = '${CHINA_SLOC}' AND il.stocked_quantity > 0
`

// Active China transfers (origin CN, status confirmed|shipped) with an
// UNBILLED remainder — the "unbilled balance" gap the operator can't see in
// the plain Balance.
//
// A China reservation is created at draft→confirmed and persists through
// shipped until received in Miami, so the moment a transfer is confirmed its
// pending units leave "+ Inv Value". `reserved_pending_value` values those
// units on the SAME basis (`FACTORY_COST` = purchase_cost) as the inventory
// `value` above.
//
// We NET against what is already billed for the PO rather than excluding the
// whole transfer once any bill exists. Today Veetech bills the full shipment at
// once, so `billed_cents` covers (usually exceeds) the reserved value and the
// remainder clamps to 0 — identical to the old NOT-EXISTS behaviour. But if a
// PO is ever billed in parts, the unbilled remainder still surfaces correctly:
//   unbilled = MAX(0, reserved_pending_value − billed_cents)
// `billed_cents` = Σ china_finance_bill.amount_cents matched to the PO (same
// predicate as before, kept as a single OR so each bill row — incl. split
// "Partial #N" children — is counted exactly once, never doubled).
const POS_WITHOUT_BILLS_SQL = `
  SELECT
    t.po_number,
    t.qb_po_number,
    t.transfer_number,
    t.transfer_status,
    t.vendor_name,
    ROUND(GREATEST(0, t.reserved_pending_cents - b.billed_cents)::numeric / 100, 2) AS unbilled_value
  FROM (
    SELECT
      po.id                                  AS po_id,
      po.number                              AS po_number,
      po.qb_purchase_order_txn_number        AS qb_po_number,
      it.number                              AS transfer_number,
      it.status                              AS transfer_status,
      COALESCE(NULLIF(TRIM(po.vendor_name_snapshot), ''), 'Unknown') AS vendor_name,
      COALESCE(SUM(
        GREATEST(0, itl.qty - COALESCE(itl.qty_received, 0)) * ${FACTORY_COST}
      ), 0) * 100                            AS reserved_pending_cents
    FROM inventory_transfer it
    JOIN purchase_order po
      ON po.id = it.linked_purchase_order_id
     AND po.deleted_at IS NULL
    LEFT JOIN inventory_transfer_line itl
      ON itl.transfer_id = it.id
     AND itl.deleted_at IS NULL
    LEFT JOIN product_variant pv
      ON pv.id = itl.product_variant_id
     AND pv.deleted_at IS NULL
    WHERE it.deleted_at IS NULL
      AND it.origin_country = 'CN'
      AND it.status IN ('confirmed', 'shipped')
    GROUP BY po.id, po.number, po.qb_purchase_order_txn_number, it.number, it.status, po.vendor_name_snapshot
  ) t
  CROSS JOIN LATERAL (
    SELECT COALESCE(SUM(cfb.amount_cents), 0) AS billed_cents
    FROM china_finance_bill cfb
    WHERE cfb.po_number     = t.qb_po_number
       OR cfb.po_ref_number = t.po_number
       OR cfb.vendor_bill_id IN (
         SELECT vb.id
         FROM vendor_bill vb
         WHERE vb.purchase_order_id = t.po_id
           AND vb.deleted_at IS NULL
       )
  ) b
  WHERE t.reserved_pending_cents - b.billed_cents > 0
  ORDER BY t.po_number ASC
`

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const pg = req.scope.resolve("__pg_connection__") as any

  try {
    const [byFactoryRes, byCategoryRes, posWithoutBillsRes] = await Promise.all([
      pg.raw(
        `WITH RECURSIVE ${TIER1_CTE}
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
        `WITH RECURSIVE ${TIER1_CTE}
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
      status:          String(r.transfer_status ?? ''),
      vendor_name:     String(r.vendor_name ?? 'Unknown'),
      value:           Number(r.unbilled_value ?? 0),
    }))

    // Total debt owed to the China agent for goods already reserved out of the
    // inventory value (confirmed|shipped transfers) but not yet on a vendor bill.
    const unbilledValue =
      Math.round(posWithoutBills.reduce((s, r) => s + r.value, 0) * 100) / 100

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
      unbilled: { value: unbilledValue },
    })
  } catch (err) {
    console.error("[factory-orders/china-inventory]", err)
    return res.status(500).json({ error: "Failed to fetch China inventory" })
  }
}

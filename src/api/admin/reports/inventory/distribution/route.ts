/**
 * GET /admin/reports/inventory/distribution?group_by=category|vendor|active
 *
 * Live snapshot of how current inventory VALUE is distributed.
 * Mirrors the Supply Chain live-value semantics exactly so totals reconcile:
 *   qty   = GREATEST(0, stocked - reserved)  (available, per location)
 *   USA   valued at landed avg cost (avgCostDollars)
 *   China valued at raw factory cost (purchaseCostDollars)
 *
 * group_by=active classifies each SKU against the configurable list of
 * "active" prefixes (purchasing_config key `inventory_active_sku_prefixes`,
 * comma-separated). Matching: dashed SKUs match on first dash-token equality
 * (ESP-123 matches ESP, ESP2-123 does not); dash-less SKUs match on prefix
 * (E01AMPT024 matches E01). Everything unmatched = obsolete.
 */
import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"

import { avgCostDollars, purchaseCostDollars } from "../../../../../lib/cost/cost-sql"
import { USA_LOC, CHINA_LOC } from "../../../../../lib/locations"
import { TIER1_CTE } from "../../_lib/category-tier1"

export const ACTIVE_PREFIXES_CONFIG_KEY = "inventory_active_sku_prefixes"

const GROUP_BYS = ["category", "vendor", "active"] as const
type GroupBy = (typeof GROUP_BYS)[number]

// One row per variant with available qty + cost per location. Variants whose
// available qty is 0 in both warehouses (fully reserved) are filtered out by
// the callers so SKU counts stay meaningful.
const INV_CTE = `inv AS (
  SELECT
    pv.id                                          AS variant_id,
    pv.sku,
    pv.product_id,
    SUM(CASE WHEN il.location_id = ? THEN GREATEST(0, il.stocked_quantity - COALESCE(il.reserved_quantity, 0)) ELSE 0 END)::numeric AS qty_usa,
    SUM(CASE WHEN il.location_id = ? THEN GREATEST(0, il.stocked_quantity - COALESCE(il.reserved_quantity, 0)) ELSE 0 END)::numeric AS qty_china,
    COALESCE(${avgCostDollars("pv")}, 0)           AS landed_cost,
    COALESCE(${purchaseCostDollars("pv")}, 0)      AS factory_cost
  FROM inventory_level il
  JOIN inventory_item ii ON ii.id = il.inventory_item_id
  JOIN product_variant_inventory_item pvii ON pvii.inventory_item_id = ii.id
  JOIN product_variant pv ON pv.id = pvii.variant_id AND pv.deleted_at IS NULL
  WHERE il.location_id IN (?, ?) AND il.stocked_quantity > 0
  GROUP BY pv.id
)`

const AGGREGATES = `
  COUNT(DISTINCT b.variant_id)::int                                   AS skus,
  SUM(b.qty_usa)::numeric                                             AS qty_usa,
  SUM(b.qty_china)::numeric                                           AS qty_china,
  ROUND(SUM(b.qty_usa * b.landed_cost)::numeric, 2)                   AS value_usa,
  ROUND(SUM(b.qty_china * b.factory_cost)::numeric, 2)                AS value_china,
  COUNT(DISTINCT b.variant_id) FILTER (
    WHERE (b.qty_usa > 0 AND b.landed_cost <= 0)
       OR (b.qty_china > 0 AND b.factory_cost <= 0)
  )::int                                                              AS zero_cost_variants`

// Product join + drop fully-reserved variants (0 available everywhere).
const BASE_FROM = `FROM inv
  JOIN product p ON p.id = inv.product_id AND p.deleted_at IS NULL
  WHERE inv.qty_usa > 0 OR inv.qty_china > 0`

export function sanitizeActivePrefixes(raw: string | null | undefined): string[] {
  if (!raw) return []
  const seen = new Set<string>()
  for (const part of raw.split(",")) {
    const p = part.trim().toUpperCase()
    if (p && /^[A-Z0-9]+$/.test(p)) seen.add(p)
  }
  return [...seen]
}

interface RawRow {
  label: string
  category_id?: string | null
  grp?: "active" | "obsolete"
  skus: string | number
  qty_usa: string | number
  qty_china: string | number
  value_usa: string | number
  value_china: string | number
  zero_cost_variants: string | number
}

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const groupBy = String(req.query.group_by ?? "") as GroupBy
  if (!GROUP_BYS.includes(groupBy)) {
    return res.status(400).json({ error: "group_by must be one of: category, vendor, active" })
  }

  const pg = req.scope.resolve("__pg_connection__") as any

  try {
    let result: { rows: RawRow[] }
    let activePrefixes: string[] | undefined

    if (groupBy === "category") {
      result = await pg.raw(
        `WITH RECURSIVE ${TIER1_CTE}, ${INV_CTE}
         SELECT
           COALESCE(pt.category, 'Uncategorized') AS label,
           pt.category_id                         AS category_id,
           ${AGGREGATES}
         FROM (SELECT inv.* ${BASE_FROM}) b
         LEFT JOIN product_tier1 pt ON pt.product_id = b.product_id
         GROUP BY 1, 2
         ORDER BY (SUM(b.qty_usa * b.landed_cost) + SUM(b.qty_china * b.factory_cost)) DESC`,
        [USA_LOC, CHINA_LOC, USA_LOC, CHINA_LOC]
      )
    } else if (groupBy === "vendor") {
      result = await pg.raw(
        `WITH ${INV_CTE}
         SELECT
           COALESCE(NULLIF(TRIM(b.vendor), ''), 'Unknown') AS label,
           ${AGGREGATES}
         FROM (SELECT inv.*, p.metadata->>'qb_vendor_full_name' AS vendor ${BASE_FROM}) b
         GROUP BY 1
         ORDER BY (SUM(b.qty_usa * b.landed_cost) + SUM(b.qty_china * b.factory_cost)) DESC`,
        [USA_LOC, CHINA_LOC, USA_LOC, CHINA_LOC]
      )
    } else {
      const cfg = await pg.raw(`SELECT value FROM purchasing_config WHERE key = ?`, [
        ACTIVE_PREFIXES_CONFIG_KEY,
      ])
      activePrefixes = sanitizeActivePrefixes(cfg.rows[0]?.value)
      const prefixCsv = activePrefixes.join(",")

      result = await pg.raw(
        `WITH ${INV_CTE}
         SELECT
           CASE WHEN m.pf IS NOT NULL THEN 'active' ELSE 'obsolete' END AS grp,
           COALESCE(
             m.pf,
             NULLIF(
               CASE WHEN position('-' in b.sku_u) > 0
                    THEN split_part(b.sku_u, '-', 1)
                    ELSE COALESCE(substring(b.sku_u from '^[A-Z]+[0-9]{0,3}'), b.sku_u)
               END, ''),
             '(NO SKU)'
           ) AS label,
           ${AGGREGATES}
         FROM (
           SELECT inv.*, UPPER(TRIM(COALESCE(inv.sku, ''))) AS sku_u ${BASE_FROM}
         ) b
         LEFT JOIN LATERAL (
           SELECT pf FROM unnest(string_to_array(?, ',')) pf
           WHERE (position('-' in b.sku_u) > 0 AND split_part(b.sku_u, '-', 1) = pf)
              OR (position('-' in b.sku_u) = 0 AND b.sku_u LIKE pf || '%')
           ORDER BY length(pf) DESC
           LIMIT 1
         ) m ON true
         GROUP BY 1, 2
         ORDER BY 1, (SUM(b.qty_usa * b.landed_cost) + SUM(b.qty_china * b.factory_cost)) DESC`,
        [USA_LOC, CHINA_LOC, USA_LOC, CHINA_LOC, prefixCsv]
      )
    }

    const rows = result.rows.map((r) => {
      const valueUsa = Number(r.value_usa)
      const valueChina = Number(r.value_china)
      return {
        label: r.label,
        ...(groupBy === "category" ? { category_id: r.category_id ?? null } : {}),
        ...(groupBy === "active" ? { group: r.grp } : {}),
        skus: Number(r.skus),
        qty_usa: Number(r.qty_usa),
        qty_china: Number(r.qty_china),
        value_usa: valueUsa,
        value_china: valueChina,
        value_total: Math.round((valueUsa + valueChina) * 100) / 100,
        zero_cost_variants: Number(r.zero_cost_variants),
      }
    })

    const totals = rows.reduce(
      (acc, r) => ({
        skus: acc.skus + r.skus,
        qty_usa: acc.qty_usa + r.qty_usa,
        qty_china: acc.qty_china + r.qty_china,
        value_usa: Math.round((acc.value_usa + r.value_usa) * 100) / 100,
        value_china: Math.round((acc.value_china + r.value_china) * 100) / 100,
        value_total: Math.round((acc.value_total + r.value_total) * 100) / 100,
        zero_cost_variants: acc.zero_cost_variants + r.zero_cost_variants,
      }),
      { skus: 0, qty_usa: 0, qty_china: 0, value_usa: 0, value_china: 0, value_total: 0, zero_cost_variants: 0 }
    )

    return res.json({
      rows,
      totals,
      ...(activePrefixes ? { active_prefixes: activePrefixes } : {}),
      as_of: new Date().toISOString(),
    })
  } catch (err) {
    console.error("[reports/inventory/distribution] query failed:", err)
    return res.status(500).json({ error: "Failed to fetch inventory distribution" })
  }
}

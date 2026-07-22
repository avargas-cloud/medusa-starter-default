/**
 * verify-inventory-distribution.ts — exercises the REAL route handler for
 * GET /admin/reports/inventory/distribution against the live DB (read-only).
 *
 * Invariants checked:
 *  1. All three group_by modes return 200 with non-empty rows.
 *  2. Partition invariance: category / vendor / active are three partitions of
 *     the same variant set → totals must match exactly across modes.
 *  3. Totals reconcile with an independent supply-chain-style live value query
 *     (same semantics: available = GREATEST(0, stocked - reserved), USA at
 *     landed avg cost, China at factory cost).
 *  4. active mode: every row is grouped active|obsolete and echoes prefixes.
 *
 * Run: cd backend && env DATABASE_URL=... ./node_modules/.bin/tsx src/scripts/verify/verify-inventory-distribution.ts
 */
import Knex from "knex"

import { GET } from "../../api/admin/reports/inventory/distribution/route"
import { avgCostDollars, purchaseCostDollars } from "../../lib/cost/cost-sql"
import { USA_LOC, CHINA_LOC } from "../../lib/locations"

interface Captured {
  status: number
  body: any
}

async function callRoute(pg: any, groupBy: string): Promise<Captured> {
  const captured: Captured = { status: 200, body: null }
  const req = {
    query: { group_by: groupBy },
    scope: { resolve: () => pg },
  } as any
  const res = {
    status(code: number) {
      captured.status = code
      return this
    },
    json(payload: any) {
      captured.body = payload
      return this
    },
  } as any
  await GET(req, res)
  return captured
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required")
  const pg = Knex({ client: "pg", connection: process.env.DATABASE_URL })
  let failures = 0
  const fail = (msg: string) => {
    failures++
    console.error(`  ❌ ${msg}`)
  }
  const ok = (msg: string) => console.log(`  ✅ ${msg}`)

  try {
    const results: Record<string, Captured> = {}
    for (const gb of ["category", "vendor", "active"]) {
      const r = await callRoute(pg, gb)
      results[gb] = r
      if (r.status !== 200) fail(`${gb}: status ${r.status} — ${JSON.stringify(r.body)}`)
      else if (!Array.isArray(r.body?.rows) || r.body.rows.length === 0) fail(`${gb}: empty rows`)
      else ok(`${gb}: 200, ${r.body.rows.length} rows, total $${r.body.totals.value_total}`)
    }

    const bad = await callRoute(pg, "nonsense")
    if (bad.status === 400) ok("invalid group_by → 400")
    else fail(`invalid group_by returned ${bad.status}`)

    // 2. Partition invariance across modes
    const t = (gb: string) => results[gb]?.body?.totals
    for (const key of ["skus", "qty_usa", "qty_china", "value_usa", "value_china"]) {
      const vals = ["category", "vendor", "active"].map((gb) => t(gb)?.[key])
      const drift = Math.max(...vals) - Math.min(...vals)
      if (drift > 0.05) fail(`totals.${key} diverges across modes: ${vals.join(" / ")}`)
      else ok(`totals.${key} consistent across modes (${vals[0]})`)
    }

    // 3. Independent reconciliation (supply-chain live value semantics)
    const AVAILABLE = `GREATEST(0, il.stocked_quantity - COALESCE(il.reserved_quantity, 0))`
    const independent = await pg.raw(
      `SELECT
         COALESCE(ROUND(SUM(CASE WHEN il.location_id = ? THEN ${AVAILABLE} * COALESCE(${avgCostDollars("pv")}, 0) ELSE 0 END)::numeric, 2), 0) AS value_usa,
         COALESCE(ROUND(SUM(CASE WHEN il.location_id = ? THEN ${AVAILABLE} * COALESCE(${purchaseCostDollars("pv")}, 0) ELSE 0 END)::numeric, 2), 0) AS value_china
       FROM inventory_level il
       JOIN inventory_item ii ON ii.id = il.inventory_item_id
       JOIN product_variant_inventory_item pvii ON pvii.inventory_item_id = ii.id
       JOIN product_variant pv ON pv.id = pvii.variant_id AND pv.deleted_at IS NULL
       JOIN product p ON p.id = pv.product_id AND p.deleted_at IS NULL
       WHERE il.location_id IN (?, ?) AND il.stocked_quantity > 0`,
      [USA_LOC, CHINA_LOC, USA_LOC, CHINA_LOC]
    )
    const ind = independent.rows[0]
    const catTotals = t("category")
    for (const [key, expected] of [
      ["value_usa", Number(ind.value_usa)],
      ["value_china", Number(ind.value_china)],
    ] as const) {
      const got = Number(catTotals?.[key])
      if (Math.abs(got - expected) > 0.05) fail(`${key}: route=${got} vs independent=${expected}`)
      else ok(`${key} reconciles with independent query ($${expected})`)
    }

    // 4. active mode shape
    const activeBody = results["active"]?.body
    if (activeBody) {
      const badGroups = activeBody.rows.filter((r: any) => r.group !== "active" && r.group !== "obsolete")
      if (badGroups.length) fail(`active mode: ${badGroups.length} rows without valid group`)
      else ok("active mode: every row grouped active|obsolete")
      if (!Array.isArray(activeBody.active_prefixes)) fail("active mode: missing active_prefixes echo")
      else ok(`active mode: prefixes echoed [${activeBody.active_prefixes.join(", ")}]`)
      const activeRows = activeBody.rows.filter((r: any) => r.group === "active")
      const obsoleteVal = activeBody.rows
        .filter((r: any) => r.group === "obsolete")
        .reduce((s: number, r: any) => s + r.value_total, 0)
      console.log(
        `  ℹ️  active rows: ${activeRows.length}, obsolete value: $${Math.round(obsoleteVal * 100) / 100}`
      )
    }

    console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`)
    process.exitCode = failures === 0 ? 0 : 1
  } finally {
    await pg.destroy()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

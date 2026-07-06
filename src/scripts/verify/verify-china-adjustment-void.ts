import { ExecArgs } from "@medusajs/framework/types"
import { Modules } from "@medusajs/utils"
import { CHINA_LOC } from "../../lib/locations"

/**
 * Regression test for the China Adjustment VOID path — specifically the tricky
 * case: create → intermediate stock move (simulated sale) → EDIT → VOID.
 *
 * Because PATCH now uses delta-differential math, the stored net `delta` equals
 * the actual movement the adjustment applied, so voiding (reverse −delta) lands
 * stock exactly at "as if the adjustment never happened" (original − sale),
 * surviving the intermediate change. Also checks the 409 guards.
 *
 * Run: env DATABASE_URL=... MEDUSA_BACKEND_URL=... TEST_ADMIN_EMAIL/PASSWORD=... \
 *      npx medusa exec ./src/scripts/verify/verify-china-adjustment-void.ts
 */
const BACKEND = process.env.MEDUSA_BACKEND_URL ?? "http://localhost:9099"
const ITEM = { inventory_item_id: "iitem_01KFS1G4TBTQK10N5Q5FB62X1Q", sku: "ECN-EDG-PIGD-10" }

export default async function verify({ container }: ExecArgs) {
  const knex = container.resolve("__pg_connection__") as {
    raw: (sql: string, b?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>
  }
  const inv = container.resolve(Modules.INVENTORY) as {
    adjustInventory: (iid: string, loc: string, delta: number) => Promise<unknown>
  }

  const stocked = async () =>
    Number((await knex.raw(
      `SELECT stocked_quantity FROM inventory_level WHERE inventory_item_id=? AND location_id=?`,
      [ITEM.inventory_item_id, CHINA_LOC]
    )).rows[0]?.stocked_quantity ?? 0)
  const reserved = async () =>
    Number((await knex.raw(
      `SELECT reserved_quantity FROM inventory_level WHERE inventory_item_id=? AND location_id=?`,
      [ITEM.inventory_item_id, CHINA_LOC]
    )).rows[0]?.reserved_quantity ?? 0)

  let ok = true
  const check = (label: string, got: number, want: number) => {
    const pass = got === want
    ok = ok && pass
    console.log(`  ${pass ? "✅" : "❌"} ${label}: ${got} (esperado ${want})`)
  }

  const email = process.env.TEST_ADMIN_EMAIL ?? "sandbox@test.com"
  const password = process.env.TEST_ADMIN_PASSWORD ?? "sandbox123"
  const auth = await fetch(`${BACKEND}/auth/user/emailpass`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  })
  const token = ((await auth.json()) as { token?: string }).token!
  const api = (path: string, method: string, body?: unknown) =>
    fetch(`${BACKEND}${path}`, {
      method,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: body ? JSON.stringify(body) : undefined,
    })

  console.log("\n=== VOID regression: create → sale → edit → void ===\n")
  const stocked0 = await stocked()
  const avail0 = stocked0 - (await reserved())
  console.log(`BEFORE stocked=${stocked0} available=${avail0}`)

  // 1) create: enter available + 10
  const createRes = await (await api("/admin/china-adjustment", "POST", {
    notes: "void-regression",
    lines: [{ ...ITEM, new_quantity: avail0 + 10 }],
  })).json() as { adjustment?: { id: string } }
  const adjId = createRes.adjustment!.id
  check("stocked after create (+10)", await stocked(), stocked0 + 10)

  // 2) simulate an intermediate sale of 3 (China stock leaves)
  await inv.adjustInventory(ITEM.inventory_item_id, CHINA_LOC, -3)
  check("stocked after sale (-3)", await stocked(), stocked0 + 7)

  // 3) edit: operator corrects the count to available + 5 (delta-differential)
  await api(`/admin/china-adjustment/${adjId}`, "PATCH", {
    notes: "void-regression edit",
    lines: [{ ...ITEM, new_quantity: avail0 + 5 }],
  })
  check("stocked after edit (applied -5, not vs-live)", await stocked(), stocked0 + 2)

  // 4) void: reverse net delta (+5) → −5. Lands at original − sale.
  const voidRes = await api(`/admin/china-adjustment/${adjId}/void`, "POST", { reason: "test" })
  check("void HTTP status", voidRes.status, 200)
  check("stocked after void (= original − sale)", await stocked(), stocked0 - 3)

  // 5) guards: double-void → 409, edit-voided → 409
  check("double void → 409", (await api(`/admin/china-adjustment/${adjId}/void`, "POST", {})).status, 409)
  check("edit voided → 409", (await api(`/admin/china-adjustment/${adjId}`, "PATCH", { lines: [{ ...ITEM, new_quantity: avail0 }] })).status, 409)

  // 6) cleanup: reverse the simulated sale
  await inv.adjustInventory(ITEM.inventory_item_id, CHINA_LOC, 3)
  check("stocked restored", await stocked(), stocked0)

  console.log(ok ? "\n✅ VOID regression PASSED\n" : "\n❌ VOID regression FAILED\n")
}

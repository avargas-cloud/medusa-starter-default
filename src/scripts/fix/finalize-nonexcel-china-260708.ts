/**
 * Final non-Excel China cleanup (2026-07-08, operator-confirmed after review):
 *   - Zero 7 oversold-phantom negatives + EPS-SPR-DCSPL6 (all shipped/consumed).
 *   - Set ENEA1-18-30 = 66 available (real China stock the Excel omitted, FO-1004).
 *
 * Available-basis (new_quantity = loose shelf). One recorded china_adjustment
 * (delta!=0 lines) + Meili sync. Dry-run default; APPLY=1 to persist.
 *   APPLY=1 env DATABASE_URL=$(grep ^DATABASE_URL= .env|cut -d= -f2-) yarn medusa exec ./src/scripts/fix/finalize-nonexcel-china-260708.ts
 */
import type { ExecArgs } from "@medusajs/framework/types";
import { Modules } from "@medusajs/utils";
import {
  computeChinaAdjustment,
  loadChinaLevels,
  type ChinaLevel,
} from "../../api/admin/china-adjustment/_lib/china-adjustment-math";
import { syncInventoryItemToMeiliSearchWorkflow } from "../../workflows/sync-inventory-item-meilisearch";

const CHINA_LOC = "sloc_01KQ14C1CFX30EDD722BF87HDM";
const NOTES =
  "Non-Excel China cleanup (2026-07-08): zero shipped/phantom negatives + EPS-SPR-DCSPL6; set ENEA1-18-30=66 (FO-1004, Excel omitted)";

const LINES: Array<{ sku: string; new_quantity: number }> = [
  { sku: "ESP-ECA40W0830", new_quantity: 0 },
  { sku: "ESP-SFA50W0860", new_quantity: 0 },
  { sku: "ESP-ECA40W0840", new_quantity: 0 },
  { sku: "ESP-SFA50W0840", new_quantity: 0 },
  { sku: "ECTSK-TWRC1C5A", new_quantity: 0 },
  { sku: "ECTSK-RM3&4C1Z", new_quantity: 0 },
  { sku: "Sample-Product", new_quantity: 0 },
  { sku: "EPS-SPR-DCSPL6", new_quantity: 0 },
  { sku: "ENEA1-18-30", new_quantity: 66 },
  // Deficit fix: 25 shipped to Miami (IT-1035, in transit) but China stocked was 0 →
  // available 0 (Excel: not in China) makes backend re-add the 25 in-transit →
  // stocked 25 → En China 0 / En Tránsito 25, deficit gone.
  { sku: "EAP-AR1-8W", new_quantity: 0 },
];

interface KnexLike {
  raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
}
interface InventoryLike {
  listInventoryLevels: (
    filters: Record<string, unknown>,
    options?: { take?: number }
  ) => Promise<Array<{ inventory_item_id: string; stocked_quantity: number }>>;
  adjustInventory: (id: string, loc: string, adj: number) => Promise<void>;
}

export default async function run({ container }: ExecArgs) {
  const apply = process.env.APPLY === "1";
  const inventoryService = container.resolve(Modules.INVENTORY) as unknown as InventoryLike;
  const knex = container.resolve("__pg_connection__") as unknown as KnexLike;

  console.log(`\n🧹 Final non-Excel China cleanup — ${apply ? "APPLY" : "DRY-RUN"}\n`);

  const skus = LINES.map((l) => l.sku);
  const rows = (
    await knex.raw(
      `SELECT pv.sku, pvii.inventory_item_id AS iid
       FROM product_variant pv
       JOIN product_variant_inventory_item pvii ON pvii.variant_id = pv.id AND pvii.deleted_at IS NULL
       WHERE pv.deleted_at IS NULL AND pv.sku = ANY(?)`,
      [skus]
    )
  ).rows as Array<{ sku: string; iid: string }>;
  const iidBySku = new Map<string, string>();
  for (const r of rows) if (!iidBySku.has(r.sku)) iidBySku.set(r.sku, r.iid);

  const missing = skus.filter((s) => !iidBySku.has(s));
  if (missing.length) { console.error(`❌ unresolved: ${missing.join(", ")}`); return; }

  const itemIds = LINES.map((l) => iidBySku.get(l.sku)!);
  const levels = await loadChinaLevels(knex, inventoryService, CHINA_LOC, itemIds);

  const changed: Array<{ iid: string; sku: string; old: number; nq: number; delta: number; newStk: number }> = [];
  console.log(`SKU                    oldAvl   new    Δ   newStk`);
  for (const l of LINES) {
    const iid = iidBySku.get(l.sku)!;
    const level: ChinaLevel = levels.get(iid) ?? { stocked: 0, committed: 0, in_transit: 0 };
    const m = computeChinaAdjustment(level, l.new_quantity);
    console.log(`${l.sku.padEnd(22)}${String(m.oldAvailable).padStart(6)}${String(l.new_quantity).padStart(6)}${String(m.delta).padStart(5)}${String(m.newStocked).padStart(8)}`);
    if (m.delta !== 0) changed.push({ iid, sku: l.sku, old: m.oldAvailable, nq: l.new_quantity, delta: m.delta, newStk: m.newStocked });
  }
  console.log(`\n${changed.length} change · net ${changed.reduce((s, c) => s + c.delta, 0)}`);
  if (!apply) { console.log("\nDRY-RUN — no writes.\n"); return; }

  for (const c of changed) await inventoryService.adjustInventory(c.iid, CHINA_LOC, c.delta);
  const id = `chadj_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  await knex.raw(
    `INSERT INTO china_adjustment (id, notes, total_lines, created_by_user_id, created_at) VALUES (?, ?, ?, ?, now())`,
    [id, NOTES, changed.length, "system_veetech_recon"]
  );
  for (const c of changed) {
    await knex.raw(
      `INSERT INTO china_adjustment_line (id, china_adjustment_id, inventory_item_id, sku, old_qty, new_qty, delta) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [`chadj_ln_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, id, c.iid, c.sku, c.old, c.nq, c.delta]
    );
  }
  let synced = 0;
  for (const c of changed) {
    try { await syncInventoryItemToMeiliSearchWorkflow(container).run({ input: { inventoryItemId: c.iid } }); synced++; }
    catch (err) { console.warn(`⚠️  Meili ${c.sku}: ${(err as Error).message}`); }
  }
  console.log(`\n✅ APPLIED — china_adjustment ${id} · ${changed.length} lines · Meili ${synced}/${changed.length}\n`);
}

/**
 * Complete-count closure — zero every China-location SKU NOT in the Veetech Excel
 * Sheet3 (2026-07-07). The operator declared the Excel the ABSOLUTE truth of China
 * inventory, so anything not listed has zero loose shelf (available = 0).
 *
 * Available-basis (same math as reconcile-china-veetech-260707.ts): new_quantity = 0
 * → newStocked = committed + in_transit. So shipped/confirmed transfer units are
 * PRESERVED (they legitimately left/are set aside); only the loose-shelf surplus
 * (or negative phantom) collapses to 0. Items already at available 0 → delta 0 (skip).
 *
 * Records ONE voidable `china_adjustment` (only delta!=0 lines) + Meili sync.
 *
 * Dry-run (default):
 *   env DATABASE_URL=$(grep ^DATABASE_URL= .env|cut -d= -f2-) yarn medusa exec ./src/scripts/fix/zero-nonexcel-china-veetech-260707.ts
 * Apply:
 *   APPLY=1 env DATABASE_URL=$(grep ^DATABASE_URL= .env|cut -d= -f2-) yarn medusa exec ./src/scripts/fix/zero-nonexcel-china-veetech-260707.ts
 */
import type { ExecArgs } from "@medusajs/framework/types";
import { Modules } from "@medusajs/utils";
import {
  computeChinaAdjustment,
  loadChinaLevels,
} from "../../api/admin/china-adjustment/_lib/china-adjustment-math";
import { syncInventoryItemToMeiliSearchWorkflow } from "../../workflows/sync-inventory-item-meilisearch";

const CHINA_LOC = "sloc_01KQ14C1CFX30EDD722BF87HDM";
const NOTES =
  "Veetech China complete-count closure — zero non-Excel SKUs (Excel Sheet3 2026-07-07 = absolute truth)";

// The 42 SKUs present in the Excel (keep these — reconciled by reconcile-china-veetech-260707.ts).
const EXCEL_SKUS = new Set<string>([
  "EAP-ACR1-8W","EAP-AR1-8B","EAP-AR1-8S","EAP-AS1-8B","EAP-AS1-8W","EAP-SM5-8S",
  "ECN-EDG-PIGD-08","ECTSK-RFRC3C4A","ECTSK-RM1C1ZB","ECTSK-RM3&4C4Z","ECTSK-SPI-2SE3C",
  "ECTSK-ST-SE","ECTSK-ST-SE-W","EMSH4V160D15W30","EMSH4V160D15W60","EMSH4V160D30WRW3",
  "EPS-JDA2-384-24","EPS-JNA-200-24","EPS-JNA-300-24","EPS-MDA-60-24","EPS-MDA-96-24",
  "EPS-SPR-3DEXT-10","EPS-SPR-3DSPL6","EPS-SPR-5DDC","EPS-SPR-5DSPL2","EPS-SPR-D2024",
  "EPS-SPR-D6024","EPS-SPR-D9024","EPS-SPR-MW","EPS-SPR-S-I-DDR","EPS-SPR-S-W-D",
  "EPS-SPR-S-W-TS","EPS-SWN-60-24","EPS-SWN-96-24","ESP-ECA40W0830-L","ESP-ECA40W0860",
  "ESP-SFA50W0830","ESPC1R4W40W0830","ESPDO1R4N75W1060","ESPS9R4N50W0430","ESPS9R4N50W0440",
  "ESPS9R4N50W0460",
]);

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

  console.log(`\n🧹 Zero non-Excel China SKUs (complete count) — ${apply ? "APPLY" : "DRY-RUN"}\n`);

  // Every China-location item with nonzero stock (any product; the China warehouse
  // should hold only what the Excel lists).
  const { rows } = await knex.raw(
    `SELECT il.inventory_item_id AS iid, pv.sku AS sku, il.stocked_quantity AS stocked
       FROM inventory_level il
       JOIN product_variant_inventory_item pvii ON pvii.inventory_item_id = il.inventory_item_id AND pvii.deleted_at IS NULL
       JOIN product_variant pv ON pv.id = pvii.variant_id AND pv.deleted_at IS NULL
      WHERE il.location_id = ? AND il.deleted_at IS NULL AND il.stocked_quantity <> 0`,
    [CHINA_LOC]
  );
  const targets = (rows as Array<{ iid: string; sku: string; stocked: number }>).filter(
    (r) => !EXCEL_SKUS.has(r.sku)
  );
  if (targets.length === 0) {
    console.log("Nothing to zero — no non-Excel China SKUs with stock.\n");
    return;
  }

  const levels = await loadChinaLevels(
    knex,
    inventoryService,
    CHINA_LOC,
    targets.map((t) => t.iid)
  );

  const changed: Array<{ iid: string; sku: string; old: number; delta: number; newStk: number; inT: number }> = [];
  console.log(`SKU                    stocked  oldAvl   Δ   newStk  inTransit`);
  for (const t of targets) {
    const level = levels.get(t.iid) ?? { stocked: 0, committed: 0, in_transit: 0 };
    const m = computeChinaAdjustment(level, 0); // available → 0
    if (m.delta === 0) continue;
    changed.push({ iid: t.iid, sku: t.sku, old: m.oldAvailable, delta: m.delta, newStk: m.newStocked, inT: level.in_transit });
    console.log(
      `${t.sku.padEnd(22)}${String(level.stocked).padStart(7)}${String(m.oldAvailable).padStart(8)}${String(m.delta).padStart(5)}${String(m.newStocked).padStart(8)}${String(level.in_transit).padStart(9)}`
    );
  }
  const net = changed.reduce((s, c) => s + c.delta, 0);
  console.log(`\n${changed.length} SKUs change · net delta ${net > 0 ? "+" : ""}${net}`);

  if (!apply) {
    console.log(`\nDRY-RUN — no writes. APPLY=1 to persist.\n`);
    return;
  }

  for (const c of changed) await inventoryService.adjustInventory(c.iid, CHINA_LOC, c.delta);

  const id = `chadj_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  await knex.raw(
    `INSERT INTO china_adjustment (id, notes, total_lines, created_by_user_id, created_at)
     VALUES (?, ?, ?, ?, now())`,
    [id, NOTES, changed.length, "system_veetech_recon"]
  );
  for (const c of changed) {
    const lineId = `chadj_ln_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    await knex.raw(
      `INSERT INTO china_adjustment_line (id, china_adjustment_id, inventory_item_id, sku, old_qty, new_qty, delta)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [lineId, id, c.iid, c.sku, c.old, 0, c.delta]
    );
  }
  let synced = 0;
  for (const c of changed) {
    try {
      await syncInventoryItemToMeiliSearchWorkflow(container).run({ input: { inventoryItemId: c.iid } });
      synced++;
    } catch (err) {
      console.warn(`⚠️  Meili sync failed for ${c.sku}: ${(err as Error).message}`);
    }
  }
  console.log(`\n✅ APPLIED — china_adjustment ${id} · ${changed.length} lines · Meili ${synced}/${changed.length}\n`);
}

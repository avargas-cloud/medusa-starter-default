/**
 * China inventory reconciliation — Veetech Excel "inventory china updated" (Sheet3, 2026-07-07).
 *
 * TARGETED (not a complete warehouse recount): adjusts ONLY the 42 SKUs listed in
 * the Excel. SKUs absent from the list are LEFT UNTOUCHED (unlike the frozen
 * 260701 complete-count script). Excel "Stock" column == AVAILABLE (loose shelf);
 * the shared math re-adds committed + in_transit on top → new_stocked = available
 * + committed + in_transit. See `_lib/china-adjustment-math.ts`.
 *
 * Creates ONE `china_adjustment` document with only the delta!=0 lines (voidable,
 * audited, identical shape to POST /admin/china-adjustment) + Meili sync.
 *
 * The `00074 / ECN-EDG-PIGD-08 / 101` Excel row is intentionally EXCLUDED (bad data,
 * per operator) — ECN-EDG-PIGD-08 available here is 200 (FO-1013 only).
 *
 * Dry-run (default):
 *   env DATABASE_URL=$(grep ^DATABASE_URL= .env|cut -d= -f2-) yarn medusa exec ./src/scripts/fix/reconcile-china-veetech-260707.ts
 * Apply:
 *   APPLY=1 env DATABASE_URL=$(grep ^DATABASE_URL= .env|cut -d= -f2-) yarn medusa exec ./src/scripts/fix/reconcile-china-veetech-260707.ts
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
  "Veetech China reconciliation — Excel inventory china updated Sheet3 (2026-07-07): 42 checked, source Veetech";

// Excel Sheet3 consolidated per SKU (AVAILABLE / loose-shelf count). 00074-ECN row excluded.
const EXCEL_AVAILABLE: Array<{ sku: string; available: number }> = [
  { sku: "EAP-ACR1-8W", available: 25 },
  { sku: "EAP-AR1-8B", available: 25 },
  { sku: "EAP-AR1-8S", available: 50 },
  { sku: "EAP-AS1-8B", available: 50 },
  { sku: "EAP-AS1-8W", available: 50 },
  { sku: "EAP-SM5-8S", available: 50 },
  { sku: "ECN-EDG-PIGD-08", available: 200 },
  { sku: "ECTSK-RFRC3C4A", available: 4 },
  { sku: "ECTSK-RM1C1ZB", available: 1 },
  { sku: "ECTSK-RM3&4C4Z", available: 2 },
  { sku: "ECTSK-SPI-2SE3C", available: 5 },
  { sku: "ECTSK-ST-SE", available: 3 },
  { sku: "ECTSK-ST-SE-W", available: 19 },
  { sku: "EMSH4V160D15W30", available: 40 },
  { sku: "EMSH4V160D15W60", available: 160 },
  { sku: "EMSH4V160D30WRW3", available: 40 },
  { sku: "EPS-JDA2-384-24", available: 9 },
  { sku: "EPS-JNA-200-24", available: 30 },
  { sku: "EPS-JNA-300-24", available: 18 },
  { sku: "EPS-MDA-60-24", available: 29 },
  { sku: "EPS-MDA-96-24", available: 25 },
  { sku: "EPS-SPR-3DEXT-10", available: 100 },
  { sku: "EPS-SPR-3DSPL6", available: 25 },
  { sku: "EPS-SPR-5DDC", available: 150 },
  { sku: "EPS-SPR-5DSPL2", available: 90 },
  { sku: "EPS-SPR-D2024", available: 23 },
  { sku: "EPS-SPR-D6024", available: 72 },
  { sku: "EPS-SPR-D9024", available: 54 },
  { sku: "EPS-SPR-MW", available: 80 },
  { sku: "EPS-SPR-S-I-DDR", available: 50 },
  { sku: "EPS-SPR-S-W-D", available: 50 },
  { sku: "EPS-SPR-S-W-TS", available: 30 },
  { sku: "EPS-SWN-60-24", available: 30 },
  { sku: "EPS-SWN-96-24", available: 19 },
  { sku: "ESP-ECA40W0830-L", available: 2 },
  { sku: "ESP-ECA40W0860", available: 1 },
  { sku: "ESP-SFA50W0830", available: 40 },
  { sku: "ESPC1R4W40W0830", available: 10 },
  { sku: "ESPDO1R4N75W1060", available: 48 },
  { sku: "ESPS9R4N50W0430", available: 1 },
  { sku: "ESPS9R4N50W0440", available: 10 },
  { sku: "ESPS9R4N50W0460", available: 13 },
];

interface KnexLike {
  raw: (
    sql: string,
    bindings?: unknown[]
  ) => Promise<{ rows: unknown[]; rowCount?: number }>;
}
interface InventoryLike {
  listInventoryLevels: (
    filters: Record<string, unknown>,
    options?: { take?: number }
  ) => Promise<Array<{ inventory_item_id: string; stocked_quantity: number }>>;
  adjustInventory: (
    inventory_item_id: string,
    location_id: string,
    adjustment: number
  ) => Promise<void>;
}

export default async function run({ container }: ExecArgs) {
  const apply = process.env.APPLY === "1";
  const inventoryService = container.resolve(
    Modules.INVENTORY
  ) as unknown as InventoryLike;
  const knex = container.resolve("__pg_connection__") as unknown as KnexLike;

  console.log(`\n🇨🇳 Veetech China reconciliation — Excel Sheet3 2026-07-07 (TARGETED, 42 SKUs)`);
  console.log(`Mode: ${apply ? "APPLY (writes enabled)" : "DRY-RUN (no changes)"}\n`);

  // Resolve inventory_item_id per Excel SKU.
  const skus = EXCEL_AVAILABLE.map((e) => e.sku);
  const { rows } = await knex.raw(
    `SELECT pv.sku, pvii.inventory_item_id AS iid
       FROM product_variant pv
       JOIN product_variant_inventory_item pvii
         ON pvii.variant_id = pv.id AND pvii.deleted_at IS NULL
      WHERE pv.deleted_at IS NULL AND pv.sku = ANY(?)`,
    [skus]
  );
  const iidBySku = new Map<string, string>();
  for (const r of rows as Array<{ sku: string; iid: string }>) {
    if (iidBySku.has(r.sku)) {
      console.warn(`⚠️  ${r.sku} maps to MULTIPLE inventory items — using first`);
      continue;
    }
    iidBySku.set(r.sku, r.iid);
  }
  const missing = skus.filter((s) => !iidBySku.has(s));
  if (missing.length) {
    console.error(`❌ SKUs not resolved to an inventory item: ${missing.join(", ")}`);
    return;
  }

  const itemIds = EXCEL_AVAILABLE.map((e) => iidBySku.get(e.sku)!);
  const levels = await loadChinaLevels(knex, inventoryService, CHINA_LOC, itemIds);

  const lines: Array<{
    iid: string;
    sku: string;
    oldAvailable: number;
    newAvailable: number;
    delta: number;
    newStocked: number;
    stocked: number;
    committed: number;
    inTransit: number;
    phantom: boolean;
  }> = [];

  for (const e of EXCEL_AVAILABLE) {
    const iid = iidBySku.get(e.sku)!;
    const level: ChinaLevel = levels.get(iid) ?? {
      stocked: 0,
      committed: 0,
      in_transit: 0,
    };
    const m = computeChinaAdjustment(level, e.available);
    lines.push({
      iid,
      sku: e.sku,
      oldAvailable: m.oldAvailable,
      newAvailable: m.newAvailable,
      delta: m.delta,
      newStocked: m.newStocked,
      stocked: level.stocked,
      committed: level.committed,
      inTransit: level.in_transit,
      phantom: m.preexistingPhantom,
    });
  }

  const changed = lines.filter((l) => l.delta !== 0);
  console.log(
    `SKU                    oldAvl  excel   Δ   newStk  inT  cmt  flags`
  );
  for (const l of lines) {
    if (l.delta === 0) continue;
    const flags = [l.phantom ? "PHANTOM" : "", l.inTransit ? `inT${l.inTransit}` : ""]
      .filter(Boolean)
      .join(" ");
    console.log(
      `${l.sku.padEnd(22)}${String(l.oldAvailable).padStart(6)}${String(l.newAvailable).padStart(7)}${String(l.delta).padStart(5)}${String(l.newStocked).padStart(8)}${String(l.inTransit).padStart(5)}${String(l.committed).padStart(5)}  ${flags}`
    );
  }
  const net = changed.reduce((s, l) => s + l.delta, 0);
  console.log(
    `\n${changed.length}/${lines.length} SKUs change · net delta ${net > 0 ? "+" : ""}${net} · phantom: ${lines.filter((l) => l.phantom).length}`
  );

  if (!apply) {
    console.log(`\nDRY-RUN — no writes. Re-run with APPLY=1 to persist.\n`);
    return;
  }

  // Apply deltas + persist the adjustment document (only changed lines).
  for (const l of changed) {
    await inventoryService.adjustInventory(l.iid, CHINA_LOC, l.delta);
  }

  const id = `chadj_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  await knex.raw(
    `INSERT INTO china_adjustment (id, notes, total_lines, created_by_user_id, created_at)
     VALUES (?, ?, ?, ?, now())`,
    [id, NOTES, changed.length, "system_veetech_recon"]
  );
  for (const l of changed) {
    const lineId = `chadj_ln_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    await knex.raw(
      `INSERT INTO china_adjustment_line
         (id, china_adjustment_id, inventory_item_id, sku, old_qty, new_qty, delta)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [lineId, id, l.iid, l.sku, l.oldAvailable, l.newAvailable, l.delta]
    );
  }

  // Meili sync (targeted, belt-and-suspenders on top of the PG trigger).
  let synced = 0;
  for (const l of changed) {
    try {
      await syncInventoryItemToMeiliSearchWorkflow(container).run({
        input: { inventoryItemId: l.iid },
      });
      synced++;
    } catch (err) {
      console.warn(`⚠️  Meili sync failed for ${l.sku}: ${(err as Error).message}`);
    }
  }

  console.log(`\n✅ APPLIED — china_adjustment ${id} · ${changed.length} lines · Meili ${synced}/${changed.length}\n`);
}

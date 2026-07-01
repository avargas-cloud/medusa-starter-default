/**
 * China physical-count import — Excel "Eco-Inventory record 260701".
 *
 * COMPLETE warehouse count: this sets China `stocked_quantity` for EVERY
 * China-sourced SKU (`product.metadata.is_sourced_via_agent = true`). SKUs in the
 * Excel get their physical count; SKUs NOT in the Excel are set to physical 0 (the
 * agent counted the whole warehouse and found none).
 *
 * Uses the SAME shared math as the china-adjustment endpoint
 * (`_lib/china-adjustment-math.ts`): the entered number is the PHYSICAL count and
 * `in_transit` (shipped-transfer reservations) is preserved on top of stocked
 * (so `new_stocked = physical + in_transit`, even for the write-to-zero SKUs).
 * `committed` is NOT added.
 *
 * Duplicate SKUs in the Excel (one row per Factory Order) are already
 * consolidated below into one physical count per SKU.
 *
 * Dry-run (default):
 *   env DATABASE_URL=$(grep ^DATABASE_URL= .env|cut -d= -f2-) yarn medusa exec ./src/scripts/fix/china-adjustment-from-excel-260701.ts
 * Apply:
 *   APPLY=1 env DATABASE_URL=$(grep ^DATABASE_URL= .env|cut -d= -f2-) yarn medusa exec ./src/scripts/fix/china-adjustment-from-excel-260701.ts
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

// Physical count from Excel 2026-07-01 (consolidated per unique SKU).
const COUNTS: Array<{ sku: string; physical: number }> = [
  { sku: "EAP-ACR1-8W", physical: 25 },
  { sku: "EAP-AR1-8B", physical: 25 },
  { sku: "EAP-AS1-8B", physical: 50 },
  { sku: "EAP-AS1-8W", physical: 50 },
  { sku: "EAP-SM5-8S", physical: 50 },
  { sku: "ECTSK-SPI-2SE3C", physical: 5 },
  { sku: "ECTSK-ST-SE", physical: 3 },
  { sku: "ECTSK-ST-SE-W", physical: 19 },
  { sku: "EMSH4V160D15W30", physical: 40 },
  { sku: "EMSH4V160D15W60", physical: 160 },
  { sku: "EMSH4V160D30WRW3", physical: 80 },
  { sku: "EPS-JDA2-288-24", physical: 9 },
  { sku: "EPS-JDA2-384-24", physical: 9 },
  { sku: "EPS-JNA-200-24", physical: 35 },
  { sku: "EPS-JNA-300-24", physical: 18 },
  { sku: "EPS-MDA-60-24", physical: 25 },
  { sku: "EPS-MDA-96-24", physical: 25 },
  { sku: "EPS-SPR-3DSPL6", physical: 25 },
  { sku: "EPS-SPR-5DDC", physical: 150 },
  { sku: "EPS-SPR-5DSPL2", physical: 90 },
  { sku: "EPS-SPR-D2024", physical: 38 },
  { sku: "EPS-SPR-D6024", physical: 80 },
  { sku: "EPS-SPR-D9024", physical: 80 },
  { sku: "EPS-SPR-DCSPL6", physical: 45 },
  { sku: "EPS-SPR-MW", physical: 90 },
  { sku: "EPS-SPR-S-I-DDR", physical: 50 },
  { sku: "EPS-SPR-S-W-D", physical: 100 },
  { sku: "EPS-SPR-S-W-TS", physical: 30 },
  { sku: "EPS-SWN-60-24", physical: 50 },
  { sku: "EPS-SWN-96-24", physical: 30 },
  { sku: "ESP-ECA40W0830-L", physical: 2 },
  { sku: "ESP-ECA40W0860", physical: 1 },
  { sku: "ESP-SFA50W0830", physical: 40 },
  { sku: "ESPC1R4W40W0830", physical: 20 },
  { sku: "ESPC1R4W40W0840", physical: 0 },
  { sku: "ESPC3R4N90W12RW", physical: 0 },
  { sku: "ESPDO1R4N75W1030", physical: 24 },
  { sku: "ESPDO1R4N75W1060", physical: 48 },
  { sku: "ESPS9R4N50W0430", physical: 1 },
  { sku: "ESPS9R4N50W0440", physical: 10 },
  { sku: "ESPS9R4N50W0460", physical: 13 },
];

const NOTES = "Physical count import — Excel 2026-07-01";

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

  console.log(`\n🇨🇳 China physical-count import — Excel 2026-07-01 (COMPLETE count)`);
  console.log(`Mode: ${apply ? "APPLY (writes enabled)" : "DRY-RUN (no changes)"}\n`);

  const countBySku = new Map<string, number>(
    COUNTS.map((c) => [c.sku, c.physical])
  );

  // Resolve EVERY China-sourced variant (is_sourced_via_agent). SKUs not in the
  // Excel get physical 0.
  const { rows } = await knex.raw(
    `SELECT pv.sku,
            pvii.inventory_item_id AS iid,
            NULLIF(pv.metadata->>'qb_purchase_cost','')::numeric AS cost
     FROM product p
     JOIN product_variant pv ON pv.product_id = p.id AND pv.deleted_at IS NULL
     JOIN product_variant_inventory_item pvii
       ON pvii.variant_id = pv.id AND pvii.deleted_at IS NULL
     WHERE p.deleted_at IS NULL
       AND COALESCE((p.metadata->>'is_sourced_via_agent')::boolean, false) = true
       AND pv.sku IS NOT NULL AND pv.sku <> ''
     ORDER BY pv.sku`,
    []
  );
  const targets = (
    rows as Array<{ sku: string; iid: string; cost: string | null }>
  ).map((r) => ({
    sku: r.sku,
    iid: r.iid,
    cost: Number(r.cost ?? 0),
    physical: countBySku.get(r.sku) ?? 0,
    counted: countBySku.has(r.sku),
  }));

  // Any Excel SKU not flagged China / not resolved?
  const resolvedSkus = new Set(targets.map((t) => t.sku));
  const missingExcel = COUNTS.filter((c) => !resolvedSkus.has(c.sku)).map(
    (c) => c.sku
  );

  const itemIds = targets.map((t) => t.iid);
  const levels = await loadChinaLevels(
    knex,
    inventoryService,
    CHINA_LOC,
    itemIds
  );

  const applied: Array<{
    iid: string;
    sku: string;
    counted: boolean;
    oldPhysical: number;
    newPhysical: number;
    delta: number;
    newStocked: number;
    inTransit: number;
    reserved: number;
    stockedNow: number;
    cost: number;
  }> = [];
  const warnings: string[] = [];

  for (const t of targets) {
    const level: ChinaLevel = levels.get(t.iid) ?? {
      stocked: 0,
      in_transit: 0,
    };
    const m = computeChinaAdjustment(level, t.physical);
    applied.push({
      iid: t.iid,
      sku: t.sku,
      counted: t.counted,
      oldPhysical: m.oldPhysical,
      newPhysical: m.newPhysical,
      delta: m.delta,
      newStocked: m.newStocked,
      inTransit: level.in_transit,
      reserved: level.in_transit, // committed excluded from basis; report in_transit
      stockedNow: level.stocked,
      cost: t.cost,
    });
    if (m.preexistingPhantom) {
      warnings.push(
        `${t.sku}: shipped reservations (${level.in_transit}) exceed stocked (${level.stocked}) — pre-existing phantom, applied as-is`
      );
    }
  }

  // ── Report ──
  const f = (n: number) =>
    n.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  const pad = (s: string | number, n: number) => String(s).padEnd(n);
  const padL = (s: string | number, n: number) => String(s).padStart(n);

  const changedRows = applied.filter((a) => a.delta !== 0);
  const writeOffs = applied.filter(
    (a) => !a.counted && a.oldPhysical > 0
  );

  console.log(
    `Universe: ${applied.length} China variants · ${COUNTS.length} counted in Excel · changing ${changedRows.length}`
  );
  if (missingExcel.length) {
    console.log(
      `⚠ Excel SKUs NOT resolved as China variants: ${missingExcel.join(", ")}`
    );
  }

  console.log(`\n── Changed lines (${changedRows.length}) ──`);
  console.log(
    pad("SKU", 18) +
      "C " +
      padL("phys", 6) +
      padL("inTr", 6) +
      padL("stkNow", 8) +
      padL("stkNew", 8) +
      padL("delta", 7)
  );
  console.log("-".repeat(56));
  for (const a of changedRows) {
    console.log(
      pad(a.sku, 18) +
        (a.counted ? "✓ " : "0 ") +
        padL(a.newPhysical, 6) +
        padL(a.inTransit || "", 6) +
        padL(a.stockedNow, 8) +
        padL(a.newStocked, 8) +
        padL((a.delta > 0 ? "+" : "") + a.delta, 7)
    );
  }

  // Value summary
  let curStk = 0,
    curAvail = 0,
    newStk = 0,
    newAvail = 0,
    countedValue = 0;
  for (const a of applied) {
    curStk += a.stockedNow * a.cost;
    curAvail += Math.max(0, a.stockedNow - a.reserved) * a.cost;
    newStk += a.newStocked * a.cost;
    newAvail += Math.max(0, a.newStocked - a.reserved) * a.cost;
    if (a.counted) countedValue += a.newPhysical * a.cost;
  }
  const writeOffValue = writeOffs.reduce(
    (s, a) => s + a.oldPhysical * a.cost,
    0
  );

  console.log(`\n── Value (factory cost) ──`);
  console.log(`Available:  BEFORE $${f(curAvail)}  →  AFTER $${f(newAvail)}`);
  console.log(`Stocked:    BEFORE $${f(curStk)}  →  AFTER $${f(newStk)}`);
  console.log(
    `Counted physical value: $${f(countedValue)} · write-off (${writeOffs.length} uncounted SKUs): $${f(writeOffValue)}`
  );
  if (warnings.length) {
    console.log(`\n⚠ Pre-existing phantoms (${warnings.length}, applied as-is):`);
    warnings.forEach((w) => console.log(`   - ${w}`));
  }

  if (!apply) {
    console.log(`\n✅ DRY-RUN complete. Re-run with APPLY=1 to execute.\n`);
    return;
  }

  // ── Apply ──
  let count = 0;
  for (const a of applied) {
    if (a.delta !== 0) {
      await inventoryService.adjustInventory(a.iid, CHINA_LOC, a.delta);
      count++;
    }
  }

  // Audit record (physical basis, matches endpoint semantics)
  const id = `chadj_${Date.now()}_excl260701`;
  await knex.raw(
    `INSERT INTO china_adjustment (id, notes, total_lines, created_by_user_id, created_at)
     VALUES (?, ?, ?, NULL, NOW())`,
    [id, NOTES, applied.length]
  );
  for (const a of applied) {
    const lineId = `chadj_ln_${Date.now()}_${a.sku.replace(/[^a-z0-9]/gi, "").slice(0, 20)}`;
    await knex.raw(
      `INSERT INTO china_adjustment_line
         (id, china_adjustment_id, inventory_item_id, sku, old_qty, new_qty, delta)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [lineId, id, a.iid, a.sku, a.oldPhysical, a.newPhysical, a.delta]
    );
  }

  // Meili parity (belt-and-suspenders; PG trigger also covers this)
  await Promise.allSettled(
    Array.from(new Set(applied.map((a) => a.iid))).map((inventoryItemId) =>
      syncInventoryItemToMeiliSearchWorkflow(container).run({
        input: { inventoryItemId },
      })
    )
  );

  console.log(`\n✅ Applied ${count} inventory deltas. Audit record: ${id}\n`);
}

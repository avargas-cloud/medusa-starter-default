/**
 * Applies China inventory adjustments from the 2026-05-11 physical count Excel.
 *
 * Dry-run (default):
 *   yarn medusa exec ./src/scripts/fix/fix-china-inventory-from-excel.ts
 *
 * Apply:
 *   APPLY=1 yarn medusa exec ./src/scripts/fix/fix-china-inventory-from-excel.ts
 */
import type { ExecArgs } from "@medusajs/framework/types";
import { Modules } from "@medusajs/utils";

const CHINA_LOC = "sloc_01KQ14C1CFX30EDD722BF87HDM";

// Physical count from Excel (2026-05-11) — only items with non-zero OR needing correction
// delta = excel_qty - medusa_stocked (pre-calculated, verified against prod)
const ADJUSTMENTS: Array<{ sku: string; excelQty: number; delta: number; hasReservation: boolean }> = [
  // Items with negative stocked needing correction (no active reservations)
  { sku: "EAP-AS1-8S",         excelQty:   0, delta: +250, hasReservation: false },
  { sku: "EAP-AR1-8S",         excelQty:  50, delta: +100, hasReservation: false },
  { sku: "EAP-SM5-8S",         excelQty:   0, delta:  +75, hasReservation: false },
  { sku: "EMSH4V160D15W60",    excelQty: 120, delta: +120, hasReservation: false },
  { sku: "EAP-AR1-8B",         excelQty:   5, delta:  +50, hasReservation: false },
  { sku: "EAP-AS1-8B",         excelQty:   0, delta:  +50, hasReservation: false },
  { sku: "EAP-COV1-8W",        excelQty:   0, delta:  +50, hasReservation: false },
  { sku: "EAP-CP1-8S",         excelQty:   0, delta:  +50, hasReservation: false },
  { sku: "EPS-SPR-3DEXT-10",   excelQty: 100, delta:  +50, hasReservation: false },
  { sku: "EAP-RM5-8S",         excelQty:  25, delta:  +25, hasReservation: false },
  { sku: "ECTSK-RM1C1ZW",      excelQty:   0, delta:  +20, hasReservation: true  },
  { sku: "ENEA1-18-40",        excelQty:   5, delta:  +20, hasReservation: false },
  { sku: "ESP-ECA40W0830",     excelQty:  10, delta:  +20, hasReservation: false },
  { sku: "ESP-SFA50W1060",     excelQty:   8, delta:  +17, hasReservation: false },
  { sku: "EPS-JNA-200-24",     excelQty:   1, delta:  +11, hasReservation: false },
  { sku: "ECTSK-AM1C30A",      excelQty:   0, delta:  +10, hasReservation: false },
  { sku: "ECTSK-RM1C1ZB",      excelQty:   0, delta:  +10, hasReservation: true  },
  { sku: "ECTSK-TWRC1C5A",     excelQty:   0, delta:  +10, hasReservation: true  },
  { sku: "EPS-MDA-60-24",      excelQty:   0, delta:  +10, hasReservation: true  },
  { sku: "EPS-SPR-D9024",      excelQty:   0, delta:  +10, hasReservation: true  },
  { sku: "EPS-SPR-DCSPL4",     excelQty:   0, delta:  +10, hasReservation: false },
  { sku: "ECTSK-RM3&4C4Z",     excelQty:   0, delta:   +8, hasReservation: true  },
  { sku: "ECTSK-RFRC3C4A",     excelQty:   0, delta:   +7, hasReservation: true  },
  { sku: "ECTSK-RFRC1C5A",     excelQty:   0, delta:   +6, hasReservation: true  },
  { sku: "ECTSK-RFRC4C5A",     excelQty:   0, delta:   +5, hasReservation: true  },
  // Items with too much stocked (Excel < Medusa)
  { sku: "ECTSK-RM2C1ZW",      excelQty:   0, delta:   -2, hasReservation: true  },
  { sku: "ECTSK-RM3&4C4ZB",    excelQty:   0, delta:   -3, hasReservation: true  },
  { sku: "ECTSK-TWRC5C6A",     excelQty:   0, delta:   -3, hasReservation: true  },
  { sku: "ESPC5R4N40W0850",    excelQty:   0, delta:   -5, hasReservation: true  },
  { sku: "ESPD1R4N60W1060",    excelQty:  15, delta:   -5, hasReservation: true  },
  { sku: "EPS-SPR-S-W-TS",     excelQty:  20, delta:  -15, hasReservation: true  },
  { sku: "ESPD2R4N90W10RG",    excelQty:  40, delta:  -15, hasReservation: true  },
  { sku: "EPS-MDA-96-24",      excelQty:   0, delta:   -8, hasReservation: true  },
  { sku: "ECTSK-RFRC1C15A",    excelQty:   0, delta:  -10, hasReservation: true  },
  { sku: "EPS-SPR-D6024",      excelQty: 113, delta:  -10, hasReservation: true  },
  { sku: "ESPC1R4W40W0830",    excelQty:  15, delta:  -10, hasReservation: true  },
  { sku: "ESPDO1R4N75W1040",   excelQty:  58, delta:  -10, hasReservation: true  },
  { sku: "ESPDO1R4N75W1060",   excelQty:   7, delta:  -18, hasReservation: true  },
  { sku: "ESPS9R4N50W0430",    excelQty:   0, delta:  -20, hasReservation: true  },
  { sku: "ESP-SFA50W1040",     excelQty:  29, delta:  -20, hasReservation: true  },
  { sku: "EPS-SWN-96-24",      excelQty:  13, delta:  -22, hasReservation: true  },
  { sku: "EPS-SWN-60-24",      excelQty:  20, delta:  -20, hasReservation: true  },
  { sku: "ECN-EDG-PIGD-08",    excelQty: 100, delta:  -50, hasReservation: true  },
  { sku: "EPS-JNA-300-24",     excelQty:   6, delta:  -17, hasReservation: true  },
  { sku: "ESP-SFA50W1030",     excelQty:   0, delta:  -85, hasReservation: true  },
];

export default async function fixChinaInventoryFromExcel({ container, args }: ExecArgs) {
  const apply = process.env.APPLY === "1" || (args ?? []).includes("apply");

  const inventoryService = container.resolve(Modules.INVENTORY) as any;
  const pg = container.resolve("__pg_connection__") as any;

  console.log(`\n🇨🇳 China Inventory Adjustment — 2026-05-11 physical count`);
  console.log(`Mode: ${apply ? "APPLY (writes enabled)" : "DRY-RUN (no changes)"}\n`);

  // Resolve inventory_item_id for each SKU
  const skus = ADJUSTMENTS.map((a) => a.sku);
  const { rows } = await pg.raw(
    `SELECT pv.sku, pvii.inventory_item_id, il.stocked_quantity::int AS stocked, il.reserved_quantity::int AS reserved
     FROM product_variant pv
     JOIN product_variant_inventory_item pvii ON pvii.variant_id = pv.id AND pvii.deleted_at IS NULL
     JOIN inventory_level il ON il.inventory_item_id = pvii.inventory_item_id
       AND il.location_id = '${CHINA_LOC}' AND il.deleted_at IS NULL
     WHERE pv.sku = ANY(?)`,
    [skus]
  );

  const bySkuMap = new Map<string, { inventory_item_id: string; stocked: number; reserved: number }>(
    (rows as any[]).map((r) => [r.sku, { inventory_item_id: r.inventory_item_id, stocked: r.stocked, reserved: r.reserved }])
  );

  let applied = 0;
  let skipped = 0;

  for (const adj of ADJUSTMENTS) {
    const info = bySkuMap.get(adj.sku);
    if (!info) {
      console.log(`  ⚠ ${adj.sku} — not found in Medusa China levels, skipping`);
      skipped++;
      continue;
    }

    const currentStocked = info.stocked;
    const targetStocked = adj.excelQty;
    const actualDelta = targetStocked - currentStocked;

    if (actualDelta !== adj.delta) {
      console.log(`  ⚠ ${adj.sku} — stocked changed since plan (expected delta ${adj.delta > 0 ? "+" : ""}${adj.delta}, actual ${actualDelta > 0 ? "+" : ""}${actualDelta}). Using actual delta.`);
    }

    if (actualDelta === 0) {
      skipped++;
      continue;
    }

    const reservationNote = adj.hasReservation
      ? ` [reserved=${info.reserved} — in-transit transfer]`
      : "";

    console.log(
      `  ${actualDelta > 0 ? "⬆" : "⬇"} ${adj.sku.padEnd(28)} stocked: ${currentStocked} → ${targetStocked} (${actualDelta > 0 ? "+" : ""}${actualDelta})${reservationNote}`
    );

    if (apply) {
      await inventoryService.adjustInventory(info.inventory_item_id, CHINA_LOC, actualDelta);
      applied++;
    }
  }

  if (apply) {
    // Write audit record
    const id = `chadj_${Date.now()}_excl0511`;
    await pg.raw(
      `INSERT INTO china_adjustment (id, notes, total_lines, created_by_user_id, created_at)
       VALUES (?, ?, ?, NULL, NOW())`,
      [id, "Physical count import — Excel 2026-05-11", applied]
    );
    for (const adj of ADJUSTMENTS) {
      const info = bySkuMap.get(adj.sku);
      if (!info) continue;
      const actualDelta = adj.excelQty - info.stocked;
      if (actualDelta === 0) continue;
      const lineId = `chadj_ln_${Date.now()}_${adj.sku.replace(/[^a-z0-9]/gi, "")}`;
      await pg.raw(
        `INSERT INTO china_adjustment_line (id, china_adjustment_id, inventory_item_id, sku, old_qty, new_qty, delta)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [lineId, id, info.inventory_item_id, adj.sku, info.stocked, adj.excelQty, actualDelta]
      );
    }
    console.log(`\n✅ Applied ${applied} adjustments. Audit record: ${id}`);
    console.log(`   Run 'yarn sync:meili' to update MeiliSearch.\n`);
  } else {
    console.log(`\n✅ Dry-run complete — ${ADJUSTMENTS.length - skipped} changes pending.`);
    console.log(`   Run with APPLY=1 to execute.\n`);
  }
}

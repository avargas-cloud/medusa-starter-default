/**
 * assign-china-manual-lots-veetech.ts
 *
 * Etiqueta el stock legacy de China (UNATTRIBUTED en el export FO history y en
 * el Inventory Timeline) con los FOs del Excel del dueño (2026-08-20), como
 * lotes manuales en `inventory_item.metadata.china_manual_lots` — el MISMO
 * mecanismo del AssignFoModal. NO toca stock, reservas, costos ni QB: sólo
 * agrega etiquetas. Los DEFICIT quedan como están (decisión del dueño: son los
 * controladores que no entran al inventario).
 *
 * Operaciones:
 *   - APPEND de lotes nuevos con id determinístico
 *     `mlot_veetech_20260820_<inventory_item_id>_<fo>` — correr dos veces no
 *     duplica nada (resumable por diseño: el chequeo es "¿existe ESTE lot id?").
 *   - UN update puntual: el lote 00041 de EPS-SPR-5DSPL2 pasa qty 90 → 100
 *     (el transfer IT-1042 fue de 100; con 90 quedaban 10 sin atribuir).
 *     Guard: sólo si la qty actual es 90 (si ya es 100, skip).
 *
 * Correr (desde backend/):
 *   env DATABASE_URL="$(grep ^DATABASE_URL= .env | cut -d= -f2-)" \
 *     ./node_modules/.bin/tsx src/scripts/fix/assign-china-manual-lots-veetech.ts
 *   → DRY-RUN: imprime el plan, no escribe nada.
 *   Agregar APPLY=true para escribir. Antes de escribir vuelca un backup del
 *   metadata previo de cada item afectado (stdout + archivo BACKUP_FILE).
 *
 * Escrituras: jsonb_set SOLO de la clave china_manual_lots (jamás el metadata
 * entero — regla del deep-merge/replace de Medusa: acá es SQL crudo con
 * read-modify-write, las demás claves no se tocan).
 */
import { writeFileSync } from "node:fs";
import { Pool } from "pg";

type LotSpec = { fo: string; qty: number; received_at: string | null };
const APR10 = "2026-04-10T12:00:00Z";

// SKU → lotes a agregar. Cantidades verificadas contra el legacy real de prod
// el 2026-08-20 (Σ por SKU == saldo UNATTRIBUTED, ver transcript del plan).
const MAPPING: Record<string, LotSpec[]> = {
  "EAP-AR1-8B": [{ fo: "00081", qty: 75, received_at: APR10 }],
  "EAP-AR1-8S": [
    { fo: "00076", qty: 50, received_at: APR10 },
    { fo: "00081", qty: 150, received_at: APR10 },
  ],
  "EAP-AS1-8B": [{ fo: "00081", qty: 50, received_at: APR10 }],
  "EAP-AS1-8S": [{ fo: "00081", qty: 250, received_at: APR10 }],
  "EAP-COV1-8W": [{ fo: "00076", qty: 50, received_at: APR10 }],
  "EAP-CP1-8S": [{ fo: "00081", qty: 50, received_at: APR10 }],
  "EAP-RM5-8S": [
    { fo: "00070", qty: 25, received_at: null },
    { fo: "00076", qty: 25, received_at: null },
  ],
  "EAP-RT1-8S": [{ fo: "00076", qty: 25, received_at: APR10 }],
  "EAP-SM5-8S": [{ fo: "00081", qty: 75, received_at: APR10 }],
  "EAS1-3DEXT-10": [{ fo: "00071", qty: 150, received_at: null }],
  "EAS1-3DSPL6": [{ fo: "00078", qty: 25, received_at: null }],
  "ECN-EDG-PIGD-08": [{ fo: "00078", qty: 250, received_at: null }],
  "ECN-EDG-PIGD-10": [{ fo: "00045", qty: 394, received_at: null }],
  "EMSH4V160D15W30": [{ fo: "00082", qty: 40, received_at: null }],
  "EMSH4V160D15W60": [{ fo: "00080", qty: 120, received_at: null }],
  "EMSH4V160D30WRW3": [
    { fo: "00080", qty: 40, received_at: null },
    { fo: "00082", qty: 40, received_at: null },
  ],
  "EPS-JDA2-288-24": [{ fo: "00028", qty: 8, received_at: null }],
  "EPS-JNA-200-24": [{ fo: "00063", qty: 11, received_at: null }],
  "EPS-JNA-300-24": [{ fo: "00079", qty: 30, received_at: null }],
  "EPS-MDA-60-24": [{ fo: "00063", qty: 14, received_at: null }],
  "EPS-SPR-D2024": [{ fo: "00068", qty: 28, received_at: null }],
  "EPS-SPR-D6024": [{ fo: "00065", qty: 175, received_at: null }],
  "EPS-SPR-D9024": [{ fo: "00065", qty: 36, received_at: null }],
  "EPS-SPR-MW": [{ fo: "00075", qty: 100, received_at: null }],
  "EPS-SPR-S-W-D": [{ fo: "00075", qty: 70, received_at: null }],
  "EPS-SPR-S-W-TS": [{ fo: "00075", qty: 35, received_at: null }],
  "EPS-SWN-60-24": [{ fo: "00063", qty: 60, received_at: null }],
  "EPS-SWN-96-24": [
    { fo: "00055", qty: 32, received_at: null },
    { fo: "00063", qty: 40, received_at: null },
  ],
  "ESP-ECA40W0830": [{ fo: "00083", qty: 30, received_at: null }],
  "ESPC1R4W40W0830": [{ fo: "00077", qty: 25, received_at: null }],
  "ESPDO1R4N75W1060": [
    { fo: "00061", qty: 24, received_at: null },
    { fo: "00077", qty: 24, received_at: null },
  ],
};

// Update puntual de un lote EXISTENTE: (sku, fo, qty esperada, qty nueva).
const LOT_QTY_UPDATES = [
  { sku: "EPS-SPR-5DSPL2", fo: "00041", expect: 90, next: 100 },
];

const NOTE = "Veetech legacy FO assignment — Excel del dueño 2026-08-20";

type LotRow = {
  id: string;
  qty: number;
  note: string | null;
  fo_number: string;
  received_at: string | null;
};

async function main() {
  const apply = process.env.APPLY === "true";
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL requerido (explícito, nunca heredado)");
  const host = new URL(url.replace(/^postgres(ql)?:\/\//, "http://")).hostname;
  console.log(`${apply ? "APPLY" : "DRY-RUN"} · target: ${host}`);

  const pool = new Pool({ connectionString: url });
  const backup: Record<string, unknown>[] = [];
  let appended = 0;
  let skipped = 0;
  let updated = 0;
  try {
    const skus = [...Object.keys(MAPPING), ...LOT_QTY_UPDATES.map((u) => u.sku)];
    const { rows: items } = await pool.query(
      `SELECT pv.sku, ii.id AS item_id, ii.metadata->'china_manual_lots' AS lots
         FROM product_variant pv
         JOIN product_variant_inventory_item pvii
           ON pvii.variant_id = pv.id AND pvii.deleted_at IS NULL
         JOIN inventory_item ii ON ii.id = pvii.inventory_item_id AND ii.deleted_at IS NULL
        WHERE pv.deleted_at IS NULL AND pv.sku = ANY($1)`,
      [skus]
    );
    const bySku = new Map(items.map((r) => [String(r.sku), r]));
    const missing = skus.filter((s) => !bySku.has(s));
    if (missing.length) throw new Error(`SKUs sin inventory_item: ${missing.join(", ")}`);

    for (const [sku, specs] of Object.entries(MAPPING)) {
      const row = bySku.get(sku)!;
      const itemId = String(row.item_id);
      const current: LotRow[] = Array.isArray(row.lots) ? (row.lots as LotRow[]) : [];
      const next = [...current];
      const adds: LotRow[] = [];
      for (const spec of specs) {
        const id = `mlot_veetech_20260820_${itemId}_${spec.fo}`;
        if (next.some((l) => l.id === id)) {
          skipped++;
          console.log(`  = ${sku} ${spec.fo}:${spec.qty} ya existe (${id}) — skip`);
          continue;
        }
        adds.push({ id, qty: spec.qty, note: NOTE, fo_number: spec.fo, received_at: spec.received_at });
      }
      if (!adds.length) continue;
      console.log(
        `  + ${sku}: ${adds.map((a) => `${a.fo_number}:${a.qty}`).join(" + ")} (lotes previos: ${current.length})`
      );
      appended += adds.length;
      if (apply) {
        backup.push({ item_id: itemId, sku, china_manual_lots_before: current });
        await pool.query(
          `UPDATE inventory_item
              SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{china_manual_lots}', $1::jsonb)
            WHERE id = $2`,
          [JSON.stringify([...next, ...adds]), itemId]
        );
      }
    }

    for (const u of LOT_QTY_UPDATES) {
      const row = bySku.get(u.sku)!;
      const itemId = String(row.item_id);
      const current: LotRow[] = Array.isArray(row.lots) ? (row.lots as LotRow[]) : [];
      const lot = current.find((l) => l.fo_number === u.fo);
      if (!lot) throw new Error(`${u.sku}: no existe lote ${u.fo} para actualizar`);
      if (lot.qty === u.next) {
        skipped++;
        console.log(`  = ${u.sku} lote ${u.fo} ya está en ${u.next} — skip`);
        continue;
      }
      if (lot.qty !== u.expect) {
        throw new Error(
          `${u.sku} lote ${u.fo}: qty actual ${lot.qty} ≠ esperada ${u.expect} — el estado cambió, no escribo`
        );
      }
      console.log(`  ~ ${u.sku} lote ${u.fo}: qty ${u.expect} → ${u.next}`);
      updated++;
      if (apply) {
        backup.push({ item_id: itemId, sku: u.sku, china_manual_lots_before: current });
        const next = current.map((l) => (l.fo_number === u.fo ? { ...l, qty: u.next } : l));
        await pool.query(
          `UPDATE inventory_item
              SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{china_manual_lots}', $1::jsonb)
            WHERE id = $2`,
          [JSON.stringify(next), itemId]
        );
      }
    }

    if (apply && backup.length) {
      const file =
        process.env.BACKUP_FILE ??
        `/tmp/china-manual-lots-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
      writeFileSync(file, JSON.stringify(backup, null, 2));
      console.log(`\nBackup del estado previo (${backup.length} items): ${file}`);
    }
    console.log(
      `\n${apply ? "APLICADO" : "PLAN"}: ${appended} lotes nuevos · ${updated} update de qty · ${skipped} skips (idempotencia)`
    );
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error("❌", e.message);
  process.exit(1);
});

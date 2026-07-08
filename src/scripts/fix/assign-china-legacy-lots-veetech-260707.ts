/**
 * Phase B — Manual FO lot assignment for LEGACY (old-QuickBooks) China stock.
 * Source: Veetech Excel "inventory china updated" Sheet3 (2026-07-07).
 *
 * The legacy `00XXX` FO numbers predate the current system's Factory Orders, so
 * their stock arrived unattributed. This layers a dated FO label over the
 * item's UNATTRIBUTED SURPLUS (see inventory-timeline/_lib/attribution.ts) — it
 * does NOT move stock. Run AFTER Phase A (adjustment) + Phase D (receipt dates)
 * so surplus reflects the reconciled pool.
 *
 * GUARD (per Codex): per inventory_item, only write lots if Σqty <= live residual
 * surplus. If a SKU is already fully explained by system FO receipts (no surplus,
 * e.g. the units FIFO-attribute to FO-1000/1003/1005/1012), the item is SKIPPED
 * and reported — never forced (forcing would silently not display or double-count).
 *
 * Idempotent: stable lot ids (`mlot_veetech_20260707_<iid>_<fo>`); re-running
 * REPLACES china_manual_lots wholesale per item (jsonb concat). Oldest-first.
 *
 * Dry-run (default):
 *   env DATABASE_URL=$(grep ^DATABASE_URL= .env|cut -d= -f2-) yarn medusa exec ./src/scripts/fix/assign-china-legacy-lots-veetech-260707.ts
 * Apply:
 *   APPLY=1 env DATABASE_URL=$(grep ^DATABASE_URL= .env|cut -d= -f2-) yarn medusa exec ./src/scripts/fix/assign-china-legacy-lots-veetech-260707.ts
 */
import type { ExecArgs } from "@medusajs/framework/types";
import { CHINA_LOC } from "../../lib/locations";
import {
  buildTimeline,
  type ManualLotInput,
  type ReceiptInput,
  type StockInput,
} from "../../api/admin/reports/inventory-timeline/_lib/attribution";

// Legacy lots (FO not in system range FO-1004..FO-1013), dates = Veetech warehouse entry.
const LEGACY: Array<{ fo: string; sku: string; qty: number; date: string | null }> = [
  { fo: "00029", sku: "ECTSK-RFRC3C4A", qty: 4, date: "2025-08-05" },
  { fo: "00035", sku: "ECTSK-RM1C1ZB", qty: 1, date: "2025-08-05" },
  { fo: "00035", sku: "ECTSK-RM3&4C4Z", qty: 2, date: "2025-08-05" },
  { fo: "00035", sku: "ECTSK-SPI-2SE3C", qty: 5, date: "2025-08-05" },
  { fo: "00035", sku: "ECTSK-ST-SE", qty: 3, date: "2025-08-05" },
  { fo: "00035", sku: "ECTSK-ST-SE-W", qty: 3, date: "2025-08-05" },
  { fo: "00046", sku: "ECTSK-ST-SE-W", qty: 16, date: "2025-09-15" },
  { fo: "00041", sku: "EPS-SPR-5DDC", qty: 150, date: "2025-11-08" },
  { fo: "00041", sku: "EPS-SPR-5DSPL2", qty: 90, date: "2025-11-08" },
  { fo: "00063", sku: "EPS-MDA-60-24", qty: 4, date: "2026-01-08" },
  { fo: "00063", sku: "EPS-SWN-96-24", qty: 17, date: "2026-01-08" },
  { fo: "00065", sku: "EPS-SPR-S-I-DDR", qty: 50, date: "2026-01-19" },
  { fo: "00075", sku: "EPS-SPR-MW", qty: 80, date: "2026-04-10" },
  { fo: "00075", sku: "EPS-SPR-S-W-TS", qty: 10, date: "2026-04-10" },
  { fo: "00076", sku: "EAP-AR1-8S", qty: 50, date: "2026-04-10" },
  { fo: "00077", sku: "ESPDO1R4N75W1060", qty: 24, date: "2026-04-28" },
  { fo: "00078", sku: "EPS-SPR-3DSPL6", qty: 25, date: "2026-04-20" },
  { fo: "00080", sku: "EMSH4V160D15W30", qty: 40, date: "2026-04-30" },
  { fo: "00080", sku: "EMSH4V160D15W60", qty: 80, date: "2026-04-30" },
  { fo: "00081", sku: "EAP-ACR1-8W", qty: 25, date: "2026-06-01" },
  { fo: "00081", sku: "EAP-AR1-8B", qty: 25, date: "2026-05-21" },
  { fo: "00082", sku: "EMSH4V160D15W60", qty: 80, date: "2026-05-20" },
  { fo: "00082", sku: "EMSH4V160D30WRW3", qty: 40, date: "2026-05-20" },
];

const NOTE = "Veetech legacy (old QB) — Excel Sheet3 2026-07-07";

interface KnexLike {
  raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: Record<string, unknown>[]; rowCount?: number }>;
}

// ── Timeline input SQL (mirrors inventory-timeline/route.ts) ──────────────────
const IN_TRANSIT_CTE = `
  in_transit AS (
    SELECT pvii.inventory_item_id AS inventory_item_id,
           SUM(GREATEST(0, itl.qty - COALESCE(itl.qty_received, 0)))::int AS in_transit_qty
    FROM inventory_transfer_line itl
    JOIN inventory_transfer it ON it.id = itl.transfer_id AND it.deleted_at IS NULL
    JOIN product_variant_inventory_item pvii ON pvii.variant_id = itl.product_variant_id AND pvii.deleted_at IS NULL
    WHERE itl.deleted_at IS NULL AND it.status = 'shipped' AND it.origin_country = 'CN'
    GROUP BY pvii.inventory_item_id
    HAVING SUM(GREATEST(0, itl.qty - COALESCE(itl.qty_received, 0))) > 0
  )`;
const ACTIVE_ITEMS_CTE = `
  active_items AS (
    SELECT inventory_item_id FROM inventory_level
      WHERE location_id = '${CHINA_LOC}' AND deleted_at IS NULL AND stocked_quantity <> 0
    UNION SELECT inventory_item_id FROM in_transit
  )`;
const RECEIPTS_SQL = `
  WITH ${IN_TRANSIT_CTE}, ${ACTIVE_ITEMS_CTE}
  SELECT forl.id AS line_id, forl.inventory_item_id, forl.sku_snapshot AS sku,
         forl.qty_received_now AS qty_received, fore.received_at, fore.number AS receipt_number,
         fo.number AS fo_number, fo.id AS fo_id
  FROM factory_order_receipt_line forl
  JOIN factory_order_receipt fore ON fore.id = forl.factory_order_receipt_id
  JOIN factory_order fo ON fo.id = forl.factory_order_id
  JOIN active_items ai ON ai.inventory_item_id = forl.inventory_item_id
  WHERE forl.deleted_at IS NULL AND fore.deleted_at IS NULL AND fore.status = 'applied'
    AND COALESCE(forl.qty_received_now, 0) <> 0
  ORDER BY forl.inventory_item_id, fore.received_at ASC, forl.id ASC`;
const CHINA_STOCK_SQL = `
  WITH ${IN_TRANSIT_CTE}
  SELECT il.inventory_item_id, il.stocked_quantity AS stocked,
         COALESCE(itr.in_transit_qty, 0) AS in_transit, v.sku
  FROM inventory_level il
  LEFT JOIN in_transit itr ON itr.inventory_item_id = il.inventory_item_id
  LEFT JOIN LATERAL (
    SELECT pv.sku FROM product_variant_inventory_item pvii
    JOIN product_variant pv ON pv.id = pvii.variant_id AND pv.deleted_at IS NULL
    WHERE pvii.inventory_item_id = il.inventory_item_id LIMIT 1
  ) v ON TRUE
  WHERE il.location_id = '${CHINA_LOC}' AND (il.stocked_quantity <> 0 OR itr.in_transit_qty IS NOT NULL)`;
const MANUAL_LOTS_SQL = `
  SELECT id AS inventory_item_id, metadata->'china_manual_lots' AS lots
  FROM inventory_item WHERE deleted_at IS NULL AND metadata->'china_manual_lots' IS NOT NULL`;

export default async function run({ container }: ExecArgs) {
  const apply = process.env.APPLY === "1";
  const knex = container.resolve("__pg_connection__") as unknown as KnexLike;

  console.log(`\n🏷️  Veetech legacy manual lots (Phase B) — ${apply ? "APPLY" : "DRY-RUN"}\n`);

  // Resolve iid per SKU.
  const skus = Array.from(new Set(LEGACY.map((l) => l.sku)));
  const iidRows = (
    await knex.raw(
      `SELECT pv.sku, pvii.inventory_item_id AS iid
       FROM product_variant pv
       JOIN product_variant_inventory_item pvii ON pvii.variant_id = pv.id AND pvii.deleted_at IS NULL
       WHERE pv.deleted_at IS NULL AND pv.sku = ANY(?)`,
      [skus]
    )
  ).rows as Array<{ sku: string; iid: string }>;
  const iidBySku = new Map<string, string>();
  for (const r of iidRows) if (!iidBySku.has(r.sku)) iidBySku.set(r.sku, r.iid);

  // Build live timeline → residual surplus per item.
  const [receiptRes, stockRes, manualRes] = await Promise.all([
    knex.raw(RECEIPTS_SQL),
    knex.raw(CHINA_STOCK_SQL),
    knex.raw(MANUAL_LOTS_SQL),
  ]);
  const receiptsByItem = new Map<string, ReceiptInput[]>();
  for (const r of receiptRes.rows) {
    const id = String(r.inventory_item_id ?? "");
    const received = r.received_at ? new Date(r.received_at as string).toISOString() : "";
    if (!id || !received) continue;
    const list = receiptsByItem.get(id) ?? [];
    list.push({
      line_id: String(r.line_id),
      fo_number: r.fo_number != null ? String(r.fo_number) : null,
      fo_id: r.fo_id != null ? String(r.fo_id) : null,
      receipt_number: r.receipt_number != null ? String(r.receipt_number) : null,
      sku: String(r.sku ?? ""),
      description: null,
      qty_received: Number(r.qty_received ?? 0),
      received_at: received,
    });
    receiptsByItem.set(id, list);
  }
  const stockByItem = new Map<string, StockInput>();
  for (const r of stockRes.rows) {
    const id = String(r.inventory_item_id ?? "");
    if (!id) continue;
    stockByItem.set(id, {
      inventory_item_id: id,
      sku: String(r.sku ?? ""),
      description: null,
      stocked: Number(r.stocked ?? 0),
      in_transit: Number(r.in_transit ?? 0),
    });
  }
  const existingLots = new Map<string, ManualLotInput[]>();
  for (const r of manualRes.rows) {
    const id = String(r.inventory_item_id ?? "");
    if (!id || !Array.isArray(r.lots)) continue;
    existingLots.set(id, r.lots as ManualLotInput[]);
  }
  const { residuals } = buildTimeline(receiptsByItem, stockByItem, existingLots);
  const surplusByItem = new Map(residuals.map((r) => [r.inventory_item_id, r.surplus]));

  // Group legacy lots per item, oldest-first.
  const byItem = new Map<string, Array<{ fo: string; qty: number; date: string | null }>>();
  for (const l of LEGACY) {
    const iid = iidBySku.get(l.sku);
    if (!iid) {
      console.warn(`⚠️  ${l.sku}: no inventory item — skipped`);
      continue;
    }
    const arr = byItem.get(iid) ?? [];
    arr.push({ fo: l.fo, qty: l.qty, date: l.date });
    byItem.set(iid, arr);
  }

  const skuByIid = new Map(
    Array.from(iidBySku.entries()).map(([s, i]) => [i, s] as [string, string])
  );
  let written = 0;
  const skipped: string[] = [];
  for (const [iid, lots] of byItem) {
    const sku = skuByIid.get(iid) ?? iid;
    const total = lots.reduce((s, l) => s + l.qty, 0);
    const surplus = surplusByItem.get(iid) ?? 0;
    if (total > surplus) {
      skipped.push(`${sku} (legacy ${total} > surplus ${surplus} — already system-attributed)`);
      console.log(`  SKIP  ${sku.padEnd(20)} legacy=${total} surplus=${surplus}`);
      continue;
    }
    const sorted = [...lots].sort((a, b) => (a.date ?? "9999").localeCompare(b.date ?? "9999"));
    const payload: ManualLotInput[] = sorted.map((l) => ({
      id: `mlot_veetech_20260707_${iid}_${l.fo}`,
      fo_number: l.fo,
      received_at: l.date ? `${l.date}T12:00:00Z` : null,
      qty: l.qty,
      note: NOTE,
    }));
    console.log(
      `  WRITE ${sku.padEnd(20)} surplus=${surplus} → ${payload.map((p) => `${p.fo_number}:${p.qty}@${(p.received_at ?? "null").slice(0, 10)}`).join(", ")}`
    );
    if (apply) {
      await knex.raw(
        `UPDATE inventory_item
           SET metadata = COALESCE(metadata,'{}'::jsonb) || jsonb_build_object('china_manual_lots', ?::jsonb),
               updated_at = NOW()
         WHERE id = ? AND deleted_at IS NULL`,
        [JSON.stringify(payload), iid]
      );
    }
    written++;
  }

  console.log(
    `\n${apply ? "APPLIED" : "WOULD WRITE"}: ${written} items · SKIPPED (no surplus): ${skipped.length}`
  );
  if (skipped.length) console.log("  " + skipped.join("\n  "));
  console.log("");
}

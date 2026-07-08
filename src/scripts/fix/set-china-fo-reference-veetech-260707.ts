/**
 * Populate `inventory_item.metadata.china_fo_reference` from the Veetech Excel
 * Sheet3 (2026-07-07). This is a DISPLAY-ONLY cross-reference: the Inventory
 * Timeline keeps FIFO attribution (the "FO" column = system FIFO-chosen FO), and
 * shows this operator FO number in a new "FO Ref" column so the purchasing agent
 * can cross-check against their Excel without carrying the file.
 *
 * Multi-FO SKUs store a comma list ("00080, 00082"). Idempotent (jsonb concat
 * replaces the key). Does NOT touch stock or aging.
 *
 * Dry-run (default):
 *   env DATABASE_URL=$(grep ^DATABASE_URL= .env|cut -d= -f2-) yarn medusa exec ./src/scripts/fix/set-china-fo-reference-veetech-260707.ts
 * Apply:
 *   APPLY=1 env DATABASE_URL=$(grep ^DATABASE_URL= .env|cut -d= -f2-) yarn medusa exec ./src/scripts/fix/set-china-fo-reference-veetech-260707.ts
 */
import type { ExecArgs } from "@medusajs/framework/types";

const REF: Array<{ sku: string; ref: string }> = [
  { sku: "EAP-ACR1-8W", ref: "00081" },
  { sku: "EAP-AR1-8B", ref: "00081" },
  { sku: "EAP-AR1-8S", ref: "00076" },
  { sku: "EAP-AS1-8B", ref: "1012" },
  { sku: "EAP-AS1-8W", ref: "1012" },
  { sku: "EAP-SM5-8S", ref: "1012" },
  { sku: "ECN-EDG-PIGD-08", ref: "1013" },
  { sku: "ECTSK-RFRC3C4A", ref: "00029" },
  { sku: "ECTSK-RM1C1ZB", ref: "00035" },
  { sku: "ECTSK-RM3&4C4Z", ref: "00035" },
  { sku: "ECTSK-SPI-2SE3C", ref: "00035" },
  { sku: "ECTSK-ST-SE", ref: "00035" },
  { sku: "ECTSK-ST-SE-W", ref: "00035, 00046" },
  { sku: "EMSH4V160D15W30", ref: "00080" },
  { sku: "EMSH4V160D15W60", ref: "00080, 00082" },
  { sku: "EMSH4V160D30WRW3", ref: "00082" },
  { sku: "EPS-JDA2-384-24", ref: "1005" },
  { sku: "EPS-JNA-200-24", ref: "1005, 1010" },
  { sku: "EPS-JNA-300-24", ref: "1005, 1010" },
  { sku: "EPS-MDA-60-24", ref: "00063, 1010" },
  { sku: "EPS-MDA-96-24", ref: "1010" },
  { sku: "EPS-SPR-3DEXT-10", ref: "1013" },
  { sku: "EPS-SPR-3DSPL6", ref: "00078" },
  { sku: "EPS-SPR-5DDC", ref: "00041" },
  { sku: "EPS-SPR-5DSPL2", ref: "00041" },
  { sku: "EPS-SPR-D2024", ref: "1011" },
  { sku: "EPS-SPR-D6024", ref: "1011" },
  { sku: "EPS-SPR-D9024", ref: "1011" },
  { sku: "EPS-SPR-MW", ref: "00075" },
  { sku: "EPS-SPR-S-I-DDR", ref: "00065" },
  { sku: "EPS-SPR-S-W-D", ref: "1011" },
  { sku: "EPS-SPR-S-W-TS", ref: "1011, 00075" },
  { sku: "EPS-SWN-60-24", ref: "1005, 1010" },
  { sku: "EPS-SWN-96-24", ref: "00063, 1010" },
  { sku: "ESP-ECA40W0830-L", ref: "1004" },
  { sku: "ESP-ECA40W0860", ref: "1004" },
  { sku: "ESP-SFA50W0830", ref: "1004" },
  { sku: "ESPC1R4W40W0830", ref: "1006" },
  { sku: "ESPDO1R4N75W1060", ref: "00077, 1006" },
  { sku: "ESPS9R4N50W0430", ref: "1006" },
  { sku: "ESPS9R4N50W0440", ref: "1006" },
  { sku: "ESPS9R4N50W0460", ref: "1006" },
];

interface KnexLike {
  raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: Record<string, unknown>[]; rowCount?: number }>;
}

export default async function run({ container }: ExecArgs) {
  const apply = process.env.APPLY === "1";
  const knex = container.resolve("__pg_connection__") as unknown as KnexLike;
  console.log(`\n🔖 China FO reference (display cross-ref) — ${apply ? "APPLY" : "DRY-RUN"}\n`);

  const skus = REF.map((r) => r.sku);
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

  let n = 0;
  for (const { sku, ref } of REF) {
    const iid = iidBySku.get(sku);
    if (!iid) {
      console.warn(`⚠️  ${sku}: no inventory item`);
      continue;
    }
    console.log(`  ${sku.padEnd(22)} → ${ref}`);
    if (apply) {
      await knex.raw(
        `UPDATE inventory_item
           SET metadata = COALESCE(metadata,'{}'::jsonb) || jsonb_build_object('china_fo_reference', ?::text),
               updated_at = NOW()
         WHERE id = ? AND deleted_at IS NULL`,
        [ref, iid]
      );
    }
    n++;
  }
  console.log(`\n${apply ? "APPLIED" : "WOULD SET"}: ${n} items\n`);
}

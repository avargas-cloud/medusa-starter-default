/**
 * src/scripts/sync/import-china-inventory.ts
 *
 * Lee el Excel "sku china inventory.xlsx" (raíz del workspace) y actualiza
 * el inventario en Medusa para la stock_location "China Warehouse".
 *
 * Excel format:
 *   Sheet "Sheet1"
 *     Row 1: headers → "Item" | "Quantity On Hand" | "Cost"
 *     Row 2+: data rows
 *
 * El script SOLO toca China Warehouse — Ecopowertech Miami queda intacta.
 *
 * Usage (dry-run):
 *   yarn medusa exec ./src/scripts/sync/import-china-inventory.ts
 * Usage (apply):
 *   APPLY=true yarn medusa exec ./src/scripts/sync/import-china-inventory.ts
 *
 * Optional override del archivo:
 *   EXCEL_PATH=/ruta/al/archivo.xlsx APPLY=true yarn medusa exec ...
 */

import { ExecArgs } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, Modules } from "@medusajs/utils";
import { IInventoryService, IStockLocationService } from "@medusajs/types";
import * as path from "path";
import * as XLSX from "xlsx";

const APPLY = process.env.APPLY === "true";
const CHINA_LOCATION_NAME = "China Warehouse";
const DEFAULT_EXCEL_PATH = path.join(
  __dirname,
  "../../../../",
  "sku china inventory.xlsx"
);
const EXCEL_PATH = process.env.EXCEL_PATH || DEFAULT_EXCEL_PATH;

interface ParsedRow {
  sku: string;
  qty: number;
}

function parseExcel(filePath: string): ParsedRow[] {
  const wb = XLSX.readFile(filePath);
  const ws = wb.Sheets["Sheet1"] || wb.Sheets[wb.SheetNames[0]];
  if (!ws) throw new Error(`No sheet found in ${filePath}`);

  const rows = XLSX.utils.sheet_to_json<{
    Item?: string;
    "Quantity On Hand"?: number | string;
    Cost?: number | string;
  }>(ws, { defval: null });

  const out: ParsedRow[] = [];
  for (const r of rows) {
    const sku = (r.Item ?? "").toString().trim();
    if (!sku || sku.toLowerCase().startsWith("total")) continue;
    const qtyRaw = r["Quantity On Hand"];
    const qty =
      typeof qtyRaw === "number"
        ? qtyRaw
        : parseInt(String(qtyRaw ?? "0"), 10);
    if (Number.isNaN(qty)) continue;
    out.push({ sku, qty: Math.max(0, qty) });
  }
  return out;
}

export default async function importChinaInventory({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const inventoryService: IInventoryService = container.resolve(
    Modules.INVENTORY
  );
  const stockLocationService: IStockLocationService = container.resolve(
    Modules.STOCK_LOCATION
  );
  const query = container.resolve(ContainerRegistrationKeys.QUERY);

  logger.info(
    `📦 Import China Inventory — mode=${APPLY ? "APPLY" : "DRY-RUN"}`
  );
  logger.info(`📄 Excel: ${EXCEL_PATH}`);

  // ── 1. China Warehouse location ──────────────────────────────────────────
  const envLocId = process.env.CHINA_WAREHOUSE_LOCATION_ID;
  let locationId: string | undefined = envLocId;
  if (!locationId) {
    const found = await stockLocationService.listStockLocations({
      name: CHINA_LOCATION_NAME,
    });
    if (found.length === 0) {
      logger.error(
        `❌ Stock location "${CHINA_LOCATION_NAME}" no existe. ` +
          `Crea con: yarn medusa exec ./src/scripts/sync/create-china-warehouse.ts`
      );
      return;
    }
    locationId = found[0].id;
  }
  logger.info(`📍 Location: ${CHINA_LOCATION_NAME} (${locationId})`);

  // ── 2. Parse Excel ───────────────────────────────────────────────────────
  let rows: ParsedRow[];
  try {
    rows = parseExcel(EXCEL_PATH);
  } catch (err: any) {
    logger.error(`❌ No se pudo leer el Excel: ${err.message}`);
    return;
  }
  logger.info(`📊 Filas válidas en Excel: ${rows.length}`);

  // ── 3. Map SKUs → variant + inventory_item_id ───────────────────────────
  const skus = rows.map((r) => r.sku);
  const { data: variants } = await query.graph({
    entity: "variant",
    fields: ["id", "sku", "inventory_items.inventory_item_id"],
    filters: { sku: skus },
  });

  const variantBySku = new Map<
    string,
    { id: string; inventoryItemId?: string }
  >();
  for (const v of variants as Array<{
    id: string;
    sku: string;
    inventory_items?: Array<{ inventory_item_id: string }>;
  }>) {
    if (!v.sku) continue;
    variantBySku.set(v.sku, {
      id: v.id,
      inventoryItemId: v.inventory_items?.[0]?.inventory_item_id,
    });
  }

  // ── 4. Apply per-row ─────────────────────────────────────────────────────
  let updated = 0;
  let created = 0;
  let unchanged = 0;
  let skuNotFound = 0;
  let noInventoryItem = 0;
  const missing: string[] = [];

  for (const { sku, qty } of rows) {
    const variant = variantBySku.get(sku);
    if (!variant) {
      skuNotFound++;
      missing.push(sku);
      continue;
    }
    const inventoryItemId = variant.inventoryItemId;
    if (!inventoryItemId) {
      noInventoryItem++;
      logger.warn(`   ❌ ${sku}: variante sin inventory_item.`);
      continue;
    }

    try {
      const levels = await inventoryService.listInventoryLevels({
        inventory_item_id: inventoryItemId,
        location_id: locationId,
      });

      if (levels.length > 0) {
        const current = levels[0].stocked_quantity;
        if (current === qty) {
          unchanged++;
          continue;
        }
        if (APPLY) {
          await inventoryService.updateInventoryLevels({
            id: levels[0].id,
            inventory_item_id: inventoryItemId,
            location_id: locationId!,
            stocked_quantity: qty,
          });
        }
        updated++;
        logger.info(`   ✅ ${sku}: ${current} → ${qty}`);
      } else {
        if (APPLY) {
          await inventoryService.createInventoryLevels({
            inventory_item_id: inventoryItemId,
            location_id: locationId!,
            stocked_quantity: qty,
            incoming_quantity: 0,
          });
        }
        created++;
        logger.info(`   🆕 ${sku}: nuevo nivel = ${qty}`);
      }
    } catch (err: any) {
      logger.error(`   ❌ ${sku}: fallo update — ${err.message}`);
    }
  }

  // ── 5. Summary ───────────────────────────────────────────────────────────
  logger.info(`\n${"=".repeat(50)}`);
  logger.info(`✅ CHINA INVENTORY IMPORT — ${APPLY ? "APPLY" : "DRY-RUN"}`);
  logger.info(`${"=".repeat(50)}`);
  logger.info(`Filas Excel:           ${rows.length}`);
  logger.info(`Updated:               ${updated}`);
  logger.info(`Created (new level):   ${created}`);
  logger.info(`Unchanged:             ${unchanged}`);
  logger.info(`SKU no encontrado:     ${skuNotFound}`);
  logger.info(`Sin inventory_item:    ${noInventoryItem}`);
  logger.info(`${"=".repeat(50)}`);

  if (missing.length > 0) {
    logger.warn(`\n⚠️ SKUs no encontrados en Medusa (${missing.length}):`);
    for (const s of missing.slice(0, 50)) logger.warn(`   - ${s}`);
    if (missing.length > 50)
      logger.warn(`   ... (+${missing.length - 50} más)`);
  }

  if (!APPLY) {
    logger.info(
      `\nℹ️ Dry-run. Para aplicar:\n   APPLY=true yarn medusa exec ./src/scripts/sync/import-china-inventory.ts`
    );
  }
}

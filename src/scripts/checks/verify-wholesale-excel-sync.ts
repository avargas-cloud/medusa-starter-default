import * as path from "path";
import * as XLSX from "xlsx";
import { ContainerRegistrationKeys, Modules } from "@medusajs/utils";
import { IPricingModuleService } from "@medusajs/types";

/**
 * Verification script for sync-wholesale-from-excel.ts
 *
 * Reads the same wholesale.xlsx, samples up to SAMPLE_SIZE SKUs,
 * and checks that DB prices match what the sync should have applied:
 *   - price > $0  → wholesale price in DB must equal Excel value
 *   - price = $0  → NO wholesale price in DB (retail fallback active)
 *
 * Usage:
 *   yarn medusa exec ./src/scripts/checks/verify-wholesale-excel-sync.ts
 */

const XLSX_PATH = path.join(process.cwd(), "..", "wholesale.xlsx");
const SAMPLE_SIZE = 15;

export default async function verifyWholesaleExcelSync({
  container,
}: {
  container: any;
}): Promise<void> {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const log = (line: string) => logger.info(line);

  const pricingModule: IPricingModuleService = container.resolve(
    Modules.PRICING
  );
  const query = container.resolve(ContainerRegistrationKeys.QUERY);

  log(`\n🔍 Wholesale Excel Sync — Verification (sample: ${SAMPLE_SIZE} SKUs)`);
  log(`📂 Source: ${XLSX_PATH}\n`);

  // ── 1. Read Excel ──────────────────────────────────────────────────────────
  const workbook = XLSX.readFile(XLSX_PATH);
  const sheetName =
    workbook.SheetNames.find((n) => n === "Sheet1") ?? workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1 });

  const excelMap = new Map<string, number>();
  for (const row of rows) {
    const sku = String((row as unknown[])[0] ?? "").trim();
    const rawPrice = (row as unknown[])[1];
    if (!sku || ["sku", "item"].includes(sku.toLowerCase())) continue;
    const price =
      typeof rawPrice === "number"
        ? rawPrice
        : parseFloat(String(rawPrice ?? ""));
    if (!isNaN(price)) excelMap.set(sku, price);
  }

  log(`📋 Total SKUs in Excel: ${excelMap.size}`);

  // Sample: spread across the full list for better coverage
  const allSkus = Array.from(excelMap.keys());
  const step = Math.max(1, Math.floor(allSkus.length / SAMPLE_SIZE));
  const sample = allSkus.filter((_, i) => i % step === 0).slice(0, SAMPLE_SIZE);

  // ── 2. Fetch Wholesale Price List ──────────────────────────────────────────
  const allPriceLists = await pricingModule.listPriceLists();
  const wPriceList = allPriceLists.find(
    (pl: any) => pl.title === "Wholesale Pricing"
  );
  const wholesalePriceListId: string | null = wPriceList?.id ?? null;

  if (!wholesalePriceListId) {
    logger.error(`❌ Price list "Wholesale Pricing" not found`);
    return;
  }

  // ── 3. Fetch variants for sample SKUs ────────────────────────────────────
  const { data: allVariants } = await query.graph({
    entity: "variant",
    fields: ["id", "sku", "price_set.id"],
  });

  const skuToVariant = new Map<string, any>();
  for (const v of allVariants) {
    if (v.sku) skuToVariant.set(v.sku, v);
  }

  // ── 4. Fetch prices for sample price sets ─────────────────────────────────
  const samplePriceSetIds = sample
    .map((sku) => skuToVariant.get(sku)?.price_set?.id)
    .filter((id): id is string => Boolean(id));

  const allPrices =
    samplePriceSetIds.length > 0
      ? await pricingModule.listPrices(
          { price_set_id: samplePriceSetIds },
          { take: 10000 }
        )
      : [];

  const pricesMap = new Map<string, any[]>();
  for (const p of allPrices) {
    const psId = p.price_set_id!;
    if (!pricesMap.has(psId)) pricesMap.set(psId, []);
    pricesMap.get(psId)!.push(p);
  }

  // ── 5. Verify each sample SKU ─────────────────────────────────────────────
  log(`${"=".repeat(62)}`);
  log(`RESULTS`);
  log(`${"=".repeat(62)}`);

  let passed = 0;
  let failed = 0;
  let notFound = 0;

  for (const sku of sample) {
    const expectedPrice = excelMap.get(sku)!;
    const variant = skuToVariant.get(sku);

    if (!variant) {
      log(`  ❓ ${sku}: variant not found in Medusa`);
      notFound++;
      continue;
    }

    if (!variant.price_set?.id) {
      log(`  ❓ ${sku}: no price set linked`);
      notFound++;
      continue;
    }

    const currentPrices = pricesMap.get(variant.price_set.id) ?? [];
    const wholesalePrices = currentPrices.filter(
      (p: any) => p.price_list_id === wholesalePriceListId
    );
    const retailPrice = currentPrices.find((p: any) => !p.price_list_id);
    const retailDisplay = retailPrice
      ? `$${retailPrice.amount.toFixed(2)}`
      : "N/A";

    if (expectedPrice <= 0) {
      // Expected: NO wholesale price (deleted, retail fallback)
      if (wholesalePrices.length === 0) {
        log(
          `  ✅ ${sku}: $0 in Excel → no wholesale in DB ` +
            `(retail fallback: ${retailDisplay})`
        );
        passed++;
      } else {
        log(
          `  ❌ ${sku}: $0 in Excel → wholesale still exists: ` +
            `$${wholesalePrices[0].amount.toFixed(2)} (not deleted!)`
        );
        failed++;
      }
    } else {
      // Expected: wholesale price matches Excel value
      if (wholesalePrices.length === 0) {
        log(
          `  ❌ ${sku}: expected wholesale $${expectedPrice.toFixed(2)} ` +
            `→ no wholesale price found in DB`
        );
        failed++;
      } else {
        const actual = wholesalePrices[0].amount;
        if (Math.abs(actual - expectedPrice) < 0.01) {
          log(
            `  ✅ ${sku}: wholesale $${actual.toFixed(2)} ` +
              `(retail: ${retailDisplay})`
          );
          passed++;
        } else {
          log(
            `  ❌ ${sku}: expected $${expectedPrice.toFixed(2)} ` +
              `→ DB has $${actual.toFixed(2)}`
          );
          failed++;
        }
      }
    }
  }

  log(`${"=".repeat(62)}`);
  log(
    `SUMMARY: ${passed} passed | ${failed} failed | ${notFound} not found in Medusa`
  );
  log(`${"=".repeat(62)}\n`);

  if (failed > 0) {
    logger.warn(
      `⚠️  ${failed} SKU(s) did not match expected values. ` +
        `Re-run sync-wholesale-from-excel.ts if needed.`
    );
  } else {
    log(`🎉 All sampled SKUs verified successfully.`);
  }
}

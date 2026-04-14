#!/usr/bin/env tsx
import { ExecArgs } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/utils";
import * as fs from "fs";

/**
 * verify-qb-migration.ts
 *
 * Compares the total number of inventory items in the QuickBooks JSON extract
 * with the total number of variants in the Medusa database using the `qb_imported`
 * metadata flag.
 */

const QB_DATA_FILE = "/tmp/qb-active-products.json";

export default async function verifyQbMigration({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const query = container.resolve(ContainerRegistrationKeys.QUERY);

  logger.info("=".repeat(65));
  logger.info("🔍 VERIFYING QB -> MEDUSA MIGRATION COMPLETENESS");
  logger.info("=".repeat(65));

  // 1. Get QB Count
  if (!fs.existsSync(QB_DATA_FILE)) {
    logger.error(`❌ File not found: ${QB_DATA_FILE}`);
    return;
  }

  const qbRaw = JSON.parse(fs.readFileSync(QB_DATA_FILE, "utf8"));
  const qbAll: any[] = qbRaw.products || [];

  // We only care about ItemInventory that have a SKU
  const qbInventoryItems = qbAll.filter(
    (p) => p.type === "ItemInventory" && p.sku
  );
  const qbCount = qbInventoryItems.length;

  logger.info(`📦 1. QuickBooks Input:`);
  logger.info(`   - Total items in JSON: ${qbAll.length}`);
  logger.info(`   - Valid Inventory Items (with SKU): ${qbCount}`);

  // 2. Get Medusa Count (Variants)
  // Every single product has 1 variant.
  // Every variant group has N variants.
  // So the total number of Medusa *variants* should equal the number of QB *items*.
  logger.info(`\n🔍 2. Medusa Database:`);

  const { data: variants } = await query.graph({
    entity: "variant",
    fields: ["id", "sku", "product.metadata"],
  });

  // Count variants that belong to products imported from QB
  let medusaImportedCount = 0;
  let medusaTotalCount = variants.length;

  for (const v of variants as any[]) {
    if (v.product?.metadata?.qb_imported === true) {
      medusaImportedCount++;
    }
  }

  logger.info(`   - Total variants in DB: ${medusaTotalCount}`);
  logger.info(`   - Variants marked as 'qb_imported': ${medusaImportedCount}`);

  // 3. Compare and Output
  logger.info("\n" + "=".repeat(65));
  logger.info("📊 RESULTS");
  logger.info("=".repeat(65));

  if (qbCount === medusaImportedCount) {
    logger.info(`✅ PERFECT MATCH!`);
    logger.info(
      `   QuickBooks Items (${qbCount}) == Medusa Variants (${medusaImportedCount})`
    );
  } else {
    logger.warn(`⚠️ DISCREPANCY DETECTED!`);
    logger.warn(`   QuickBooks Items: ${qbCount}`);
    logger.warn(`   Medusa Variants:  ${medusaImportedCount}`);
    logger.warn(
      `   Difference:       ${Math.abs(qbCount - medusaImportedCount)}`
    );

    // Find missing SKUs
    const medusaSkus = new Set(variants.map((v: any) => v.sku?.trim()));
    const missing = qbInventoryItems.filter(
      (qb) => !medusaSkus.has(qb.sku.trim())
    );

    if (missing.length > 0) {
      logger.info(`\n🔍 Missing SKUs (${missing.length}):`);
      missing.slice(0, 20).forEach((m) => logger.info(`   - ${m.sku}`));
      if (missing.length > 20)
        logger.info(`   ... and ${missing.length - 20} more`);
    }
  }
  logger.info("=".repeat(65));
}

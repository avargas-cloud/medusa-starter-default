#!/usr/bin/env tsx
import { ExecArgs } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, Modules } from "@medusajs/utils";
import { IProductModuleService } from "@medusajs/types";
import * as fs from "fs";

/**
 * backfill-qb-ids.ts
 *
 * Backfills the `quickbooks_id` on existing Medusa variants that are missing it.
 * Reads from `/tmp/qb-active-products.json` to map SKU to ListID without
 * having to call the QuickBooks Bridge. This file contains ALL items, including
 * services and non-inventory items.
 *
 * Usage:
 *   npx medusa exec src/scripts/qb_sync/core_jobs/backfill-qb-ids.ts
 */

const QB_DATA_FILE = "/tmp/qb-active-products.json";

export default async function backfillQbIds({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const query = container.resolve(ContainerRegistrationKeys.QUERY);
  const productModule: IProductModuleService = container.resolve(Modules.PRODUCT);

  logger.info("=".repeat(65));
  logger.info("🔧 Backend - Backfilling quickbooks_id to existing Variants");
  logger.info("=".repeat(65));

  if (!fs.existsSync(QB_DATA_FILE)) {
    logger.error(`❌ Data file not found: ${QB_DATA_FILE}`);
    return;
  }

  const qbRaw = JSON.parse(fs.readFileSync(QB_DATA_FILE, "utf8"));
  const items = qbRaw.products || [];

  const skuToListIdMap = new Map<string, string>();

  // Extract from raw items
  for (const item of items) {
    if (item.sku && item.listId) {
      skuToListIdMap.set(item.sku.trim().toUpperCase(), item.listId);
    }
  }

  logger.info(`📋 Extracted ${skuToListIdMap.size} valid SKU mappings from analysis`);

  // Query Medusa for existing variants
  const { data: allVariants } = await query.graph({
    entity: "variant",
    fields: ["id", "sku", "metadata"],
    filters: {},
  });

  logger.info(`🔍 Found ${allVariants.length} total variants in Medusa`);

  const missingQbId = allVariants.filter((v: any) => {
    if (!v.sku) return false;
    const hasQbId = v.metadata && v.metadata.quickbooks_id;
    return !hasQbId;
  });

  logger.info(`🚨 Variants missing quickbooks_id: ${missingQbId.length}`);
  
  if (missingQbId.length > 0) {
    logger.info(`   List of SKUs missing quickbooks_id:`);
    // Print all or first 50
    const skusToPrint = missingQbId.map((v: any) => v.sku).slice(0, 100);
    logger.info(`   ${skusToPrint.join(", ")}${missingQbId.length > 100 ? "..." : ""}`);
  }

  const toUpdate = missingQbId.filter((v: any) => {
    // Check if we have a mapping for this SKU
    return skuToListIdMap.has(v.sku.trim().toUpperCase());
  });

  logger.info(`   Variants to update: ${toUpdate.length}`);

  if (toUpdate.length === 0) {
    logger.info("✅ No variants need backfilling. Everything is up to date.");
    return;
  }

  // Perform updates
  let updatedCount = 0;
  let failedCount = 0;

  for (const variant of toUpdate) {
    const listId = skuToListIdMap.get(variant.sku.trim().toUpperCase());
    try {
      await productModule.updateProductVariants(variant.id, {
        metadata: {
          ...(variant.metadata || {}),
          quickbooks_id: listId,
          qb_sku: variant.sku // ensure qb_sku is also there just in case
        }
      });
      updatedCount++;
      if (updatedCount % 50 === 0) {
        logger.info(`     ...updated ${updatedCount} variants`);
      }
    } catch (err: any) {
      failedCount++;
      logger.error(`     ❌ Failed to update variant ${variant.sku}: ${err.message}`);
    }
  }

  logger.info("=".repeat(65));
  logger.info(`✅ Update Complete!`);
  logger.info(`   Successfully updated: ${updatedCount}`);
  logger.info(`   Failed:               ${failedCount}`);
  logger.info("=".repeat(65));
}

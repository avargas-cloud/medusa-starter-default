/**
 * src/scripts/sync/create-china-warehouse.ts
 *
 * Creates the "China Warehouse" stock location in Medusa v2.
 *
 * Rules:
 *  - Does NOT touch the existing "Ecopowertech Miami" location.
 *  - China Warehouse is intentionally NOT linked to any sales channel
 *    or fulfillment provider — so it is INVISIBLE to POS and web checkout.
 *  - Orders always fulfill from "Ecopowertech Miami".
 *  - China Warehouse is only used by Purchase Factory (receiving) and
 *    Purchase Orders to Veetech (as the transfer origin).
 *
 * Usage:
 *   yarn medusa exec ./src/scripts/sync/create-china-warehouse.ts
 *
 * After running, add the printed ID to backend/.env:
 *   CHINA_WAREHOUSE_LOCATION_ID=sloc_...
 */

import { ExecArgs } from "@medusajs/framework/types";
import { Modules } from "@medusajs/utils";

const LOCATION_NAME = "China Warehouse";

export default async function createChinaWarehouse({ container }: ExecArgs) {
  const stockLocationService = container.resolve(Modules.STOCK_LOCATION);
  const logger = container.resolve("logger");

  // ── Check if already exists ──────────────────────────────────────────────
  const existing = await stockLocationService.listStockLocations({
    name: LOCATION_NAME,
  });

  if (existing.length > 0) {
    const loc = existing[0];
    logger.info(`✓ "${LOCATION_NAME}" already exists — no changes made.`);
    logger.info(`  ID:   ${loc.id}`);
    logger.info(`  Name: ${loc.name}`);
    logger.info(``);
    logger.info(`Add to backend/.env if not already set:`);
    logger.info(`  CHINA_WAREHOUSE_LOCATION_ID=${loc.id}`);
    return;
  }

  // ── Create location ──────────────────────────────────────────────────────
  // Intentionally NOT calling createStockLocationsWorkflow with a sales channel
  // link — that is what keeps it invisible to POS and web fulfillment.
  const location = await stockLocationService.createStockLocations({
    name: LOCATION_NAME,
    address: {
      city: "Shenzhen",
      country_code: "CN",
      address_1: "",
    },
    metadata: {
      is_purchasing_only: true,
      description:
        "EcoPowerTech China factory inventory. Not linked to any sales channel. " +
        "Used only as origin for Veetech transfer POs and destination for Purchase Factory orders.",
    },
  });

  logger.info(`✓ "${LOCATION_NAME}" created successfully.`);
  logger.info(`  ID:   ${location.id}`);
  logger.info(``);
  logger.info(`► Add to backend/.env:`);
  logger.info(`  CHINA_WAREHOUSE_LOCATION_ID=${location.id}`);
  logger.info(``);
  logger.info(`NOTE: This location has NO sales channel or fulfillment links.`);
  logger.info(`      All order fulfillment continues from "Ecopowertech Miami".`);
}

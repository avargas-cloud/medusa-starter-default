import { ExecArgs } from "@medusajs/framework/types";
import { IProductModuleService } from "@medusajs/types";
import { Modules } from "@medusajs/utils";

/**
 * create-adjustment-product.ts
 *
 * Creates the "Adjustement" OtherCharge item from QB as a Medusa product.
 * QB data (confirmed 2026-04-23):
 *   - QB Name:   Adjustement  (typo in QB — kept intentionally for sync match)
 *   - QB Type:   ItemOtherChargeRet
 *   - QB ListID: 8000018F-1352832516
 *   - IsActive:  true
 *
 * Usage:
 *   npx medusa exec ./src/scripts/qb_sync/core_jobs/create-adjustment-product.ts
 */

const QB_LIST_ID = "8000018F-1352832516";
const QB_NAME = "Adjustement";

export default async function createAdjustmentProduct({ container }: ExecArgs) {
  const logger = container.resolve("logger");
  const productModule: IProductModuleService = container.resolve(
    Modules.PRODUCT
  );

  logger.info("═".repeat(60));
  logger.info(`📦 Creating QB OtherCharge item in Medusa: "${QB_NAME}"`);
  logger.info(`   QB ListID: ${QB_LIST_ID}`);
  logger.info("═".repeat(60));

  const [created] = await productModule.createProducts([
    {
      title: QB_NAME,
      handle: "adjustement",
      status: "published" as const,
      metadata: {
        qb_item_type: "OtherCharge",
        qb_imported: true,
        qb_import_date: new Date().toISOString().slice(0, 10),
        qb_import_source: "create-adjustment-product",
      },
      variants: [
        {
          title: "Default",
          sku: QB_NAME,
          manage_inventory: false,
          allow_backorder: true,
          prices: [],
          metadata: {
            quickbooks_id: QB_LIST_ID,
            qb_sku: QB_NAME,
            qb_item_type: "OtherCharge",
          },
        },
      ],
    } as Parameters<typeof productModule.createProducts>[0][0],
  ]);

  const productId = (created as { id: string }).id;
  logger.info(`\n✅ Created Medusa product: ${productId}`);
  logger.info(`   Title:   ${QB_NAME}`);
  logger.info(`   SKU:     ${QB_NAME}`);
  logger.info(`   QB ID:   ${QB_LIST_ID}`);
  logger.info(`   Status:  published`);
  logger.info(
    `\n   Review at Admin → /app/products/${productId}`
  );
}

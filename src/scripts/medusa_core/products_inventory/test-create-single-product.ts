#!/usr/bin/env tsx
import { ExecArgs } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, Modules } from "@medusajs/utils";
import { IProductModuleService } from "@medusajs/types";

/**
 * test-create-single-product.ts
 *
 * DRY-RUN TEST: Creates 1 test product, logs result, then DELETES it.
 * Use this to verify the createProducts format before the full import.
 *
 * Usage:
 *   npx medusa exec src/scripts/migrate/test-create-single-product.ts
 */

export default async function testCreateSingleProduct({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const productModule: IProductModuleService = container.resolve(
    Modules.PRODUCT
  );

  logger.info("=".repeat(60));
  logger.info("🧪 TEST: Create 1 product (will be DELETED after test)");
  logger.info("=".repeat(60));

  const testSku = "TEST-QB-IMPORT-DELETE-ME";

  // CREATE
  logger.info(`\n1️⃣  Creating product: ${testSku}`);
  let createdId: string | null = null;

  try {
    const [result] = await productModule.createProducts([
      {
        title: testSku,
        handle: "test-qb-import-delete-me",
        status: "draft" as const,
        description: null,
        metadata: {
          sales_description:
            "TEST PRODUCT — This should be deleted automatically.",
          prerender: false,
          qb_imported: true,
          qb_import_date: "2026-03-07",
        },
        variants: [
          {
            title: "Default",
            sku: testSku,
            manage_inventory: true,
            allow_backorder: false,
            prices: [{ currency_code: "usd", amount: 9999 }], // $99.99
            metadata: { qb_sku: testSku },
          },
        ],
      } as any,
    ]);

    createdId = (result as any).id;
    logger.info(`   ✅ Product created successfully!`);
    logger.info(`   ID:     ${createdId}`);
    logger.info(`   Title:  ${(result as any).title}`);
    logger.info(`   Status: ${(result as any).status}`);
    logger.info(`   Handle: ${(result as any).handle}`);
    const v = (result as any).variants?.[0];
    if (v) {
      logger.info(`   Variant title: ${v.title}`);
      logger.info(`   Variant SKU:   ${v.sku}`);
    }
  } catch (err: any) {
    logger.error(`   ❌ CREATE FAILED: ${err.message}`);
    logger.error(`   Stack: ${err.stack?.slice(0, 300)}`);
    logger.info(
      "\n🛑 Test failed. Fix the error above before running the full import."
    );
    return;
  }

  // DELETE (cleanup)
  if (createdId) {
    logger.info(`\n2️⃣  Deleting test product (cleanup)...`);
    try {
      await productModule.deleteProducts([createdId]);
      logger.info(`   ✅ Test product deleted. Clean.`);
    } catch (err: any) {
      logger.warn(
        `   ⚠️  Delete failed (manual cleanup needed): ${err.message}`
      );
      logger.warn(`   Product ID to delete manually: ${createdId}`);
    }
  }

  logger.info("\n" + "=".repeat(60));
  logger.info("✅ TEST PASSED — Format is correct. Ready for full import.");
  logger.info(
    "   Run: npx medusa exec src/scripts/migrate/import-qb-single-products.ts"
  );
  logger.info("=".repeat(60));
}

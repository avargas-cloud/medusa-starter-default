/**
 * Verify Prices for Specific SKU
 * Shows default and wholesale prices
 */

import { Modules } from "@medusajs/utils";

export default async function verifySkuPrices({ container }: any) {
  const logger = container.resolve("logger");
  const query = container.resolve("query");
  const pricingModuleService = container.resolve(Modules.PRICING);

  const SKU = "ESPFC4R4N50W0830";

  logger.info(`\n🔍 VERIFYING PRICES FOR SKU: ${SKU}\n`);

  try {
    // 1. Find the variant with prices
    const { data: variants } = await query.graph({
      entity: "product_variant",
      fields: [
        "id",
        "sku",
        "title",
        "product.id",
        "product.title",
        "prices.id",
        "prices.amount",
        "prices.currency_code",
        "prices.price_list_id",
        "prices.price_set_id",
      ],
      filters: { sku: SKU },
    });

    if (variants.length === 0) {
      logger.info(`❌ Variant with SKU ${SKU} not found`);
      return { success: false };
    }

    const variant = variants[0];
    logger.info(`✅ Found Variant:`);
    logger.info(`   Product: ${variant.product?.title}`);
    logger.info(`   SKU: ${variant.sku}`);
    logger.info(`   Variant ID: ${variant.id}`);

    // 2. Show all prices
    if (!variant.prices || variant.prices.length === 0) {
      logger.info(`\n❌ No prices found for this variant`);
      return { success: false };
    }

    logger.info(`\n📊 Total Prices: ${variant.prices.length}`);
    logger.info(`💲 Prices:`);

    variant.prices.forEach((price: any, i: number) => {
      const label = price.price_list_id ? "WHOLESALE" : "DEFAULT";
      logger.info(`\n   [${i + 1}] ${label}`);
      logger.info(
        `       Amount: $${price.amount.toFixed(2)} ${price.currency_code}`
      );
      logger.info(
        `       Price List ID: ${price.price_list_id || "null (default)"}`
      );
      logger.info(`       Price ID: ${price.id}`);
    });

    // 3. Show discount calculation
    const defaultPrice = variant.prices.find((p: any) => !p.price_list_id);
    const wholesalePrice = variant.prices.find((p: any) => p.price_list_id);

    if (defaultPrice && wholesalePrice) {
      const discount = (
        ((defaultPrice.amount - wholesalePrice.amount) / defaultPrice.amount) *
        100
      ).toFixed(2);
      const savings = (defaultPrice.amount - wholesalePrice.amount).toFixed(2);

      logger.info(`\n📈 Comparison:`);
      logger.info(`   Default Price:    $${defaultPrice.amount.toFixed(2)}`);
      logger.info(`   Wholesale Price:  $${wholesalePrice.amount.toFixed(2)}`);
      logger.info(`   Discount:         ${discount}%`);
      logger.info(`   Savings:          $${savings}`);
      logger.info(`\n✅ WHOLESALE PRICING IS WORKING!`);
    } else if (defaultPrice && !wholesalePrice) {
      logger.info(
        `\n⚠️  WARNING: Only default price exists, no wholesale price`
      );
    } else if (!defaultPrice && wholesalePrice) {
      logger.info(
        `\n⚠️  WARNING: Only wholesale price exists, no default price`
      );
    }

    return { success: true };
  } catch (error: any) {
    logger.error(`❌ Error: ${error.message}`);
    throw error;
  }
}

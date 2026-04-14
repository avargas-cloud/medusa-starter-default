/**
 * Diagnose Price Display Issue in Admin UI
 * Checks variant → price_set → prices relationships
 */

import { Modules } from "@medusajs/utils";

export default async function diagnosePriceDisplay({ container }: any) {
  const logger = container.resolve("logger");
  const query = container.resolve("query");
  const pricingModuleService = container.resolve(Modules.PRICING);
  const productModuleService = container.resolve(Modules.PRODUCT);

  const SKU = "ESPFC4R4N50W0830";

  const log = (msg: string) => {
    console.log(msg);
    logger.info(msg);
  };

  log(`\n🔍 DIAGNOSING PRICE DISPLAY FOR SKU: ${SKU}\n`);

  try {
    // 1. Get variant with ALL price-related fields
    const { data: variants } = await query.graph({
      entity: "product_variant",
      fields: [
        "id",
        "sku",
        "title",
        "product.id",
        "product.title",
        "calculated_price.calculated_amount.amount",
        "calculated_price.calculated_amount.currency_code",
        "prices.id",
        "prices.amount",
        "prices.currency_code",
        "prices.price_list_id",
        "prices.price_set_id",
      ],
      filters: { sku: SKU },
    });

    if (variants.length === 0) {
      log(`❌ Variant not found`);
      return { success: false };
    }

    const variant = variants[0];
    log(`✅ Variant Found:`);
    log(`   ID: ${variant.id}`);
    log(`   SKU: ${variant.sku}`);
    log(`   Product: ${variant.product?.title}`);

    // 2. Check prices array from graph query
    log(`\n📊 Prices from graph query:`);
    if (variant.prices && variant.prices.length > 0) {
      variant.prices.forEach((price: any, i: number) => {
        log(`   [${i + 1}] $${price.amount} ${price.currency_code}`);
        log(`       Price ID: ${price.id}`);
        log(`       Price Set ID: ${price.price_set_id}`);
        log(`       Price List ID: ${price.price_list_id || "null"}`);
      });
    } else {
      log(`   ❌ No prices in graph query result`);
    }

    // 3. Get variant using Product Module
    const variantFromModule = await productModuleService.retrieveProductVariant(
      variant.id,
      {
        relations: ["prices"],
      }
    );

    log(`\n📊 Prices from Product Module:`);
    if (variantFromModule.prices && variantFromModule.prices.length > 0) {
      variantFromModule.prices.forEach((price: any, i: number) => {
        log(`   [${i + 1}] Found: ${JSON.stringify(price)}`);
      });
    } else {
      log(`   ❌ No prices relation in Product Module`);
    }

    // 4. Check via remoteLink
    const remoteLink = container.resolve("remoteLink");
    const links = await remoteLink.list({
      productModule: {
        variant_id: variant.id,
      },
    });

    log(`\n🔗 Remote Links:`);
    if (links && links.length > 0) {
      links.forEach((link: any, i: number) => {
        log(`   [${i + 1}] ${JSON.stringify(link)}`);
      });
    } else {
      log(`   ❌ No remote links found`);
    }

    // 5. If we have a price_set_id from prices, get price set directly
    if (variant.prices && variant.prices.length > 0) {
      const priceSetId = variant.prices[0].price_set_id;

      if (priceSetId) {
        log(`\n💲 Price Set Direct Query (ID: ${priceSetId}):`);

        const priceSets = await pricingModuleService.listPriceSets(
          {
            id: [priceSetId],
          },
          {
            relations: ["prices"],
          }
        );

        if (priceSets.length > 0) {
          const priceSet = priceSets[0];
          log(`   ✅ Price Set Found`);
          log(`   ID: ${priceSet.id}`);
          log(`   Prices in set: ${priceSet.prices?.length || 0}`);

          if (priceSet.prices) {
            priceSet.prices.forEach((price: any, i: number) => {
              log(`     [${i + 1}] $${price.amount} ${price.currency_code}`);
            });
          }
        } else {
          log(`   ❌ Price Set NOT FOUND`);
        }
      }
    }

    log(`\n${"=".repeat(70)}`);
    log(`📝 DIAGNOSIS COMPLETE`);
    log(`${"=".repeat(70)}`);

    return { success: true };
  } catch (error: any) {
    log(`❌ Error: ${error.message}`);
    console.error(error.stack);
    throw error;
  }
}

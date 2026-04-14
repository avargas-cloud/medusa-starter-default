/**
 * Test if Query.graph returns variant prices correctly
 * This verifies if Admin UI can see prices
 */

export default async function testQueryPrices({ container }: any) {
  const logger = container.resolve("logger");
  const query = container.resolve("query");

  const SKU = "ESPFC4R4N50W0830";

  const log = (msg: string) => {
    console.log(msg);
    logger.info(msg);
  };

  log(`\n🔍 TESTING QUERY.GRAPH PRICE RETRIEVAL FOR SKU: ${SKU}\n`);

  try {
    // Test 1: Get variant with prices.* (what Admin UI does)
    log("Test 1: Using variants.prices.* (Admin UI method)");
    const { data: variants1 } = await query.graph({
      entity: "product_variant",
      fields: [
        "id",
        "sku",
        "title",
        "prices.*", // This is what Admin UI expects
      ],
      filters: { sku: SKU },
    });

    if (variants1 && variants1.length > 0) {
      const variant = variants1[0];
      log(`✅ Variant found: ${variant.id}`);

      if (variant.prices && variant.prices.length > 0) {
        log(`✅ PRICES FOUND: ${variant.prices.length}`);
        variant.prices.forEach((price: any, i: number) => {
          log(`   [${i + 1}] $${price.amount} ${price.currency_code}`);
          log(`       Price ID: ${price.id}`);
          log(`       Price Set ID: ${price.price_set_id}`);
        });
      } else {
        log(`❌ NO PRICES in variant.prices`);
        log(`   prices property: ${JSON.stringify(variant.prices)}`);
      }
    } else {
      log(`❌ Variant not found`);
    }

    // Test 2: Get variant through product (alternative method)
    log(`\n\nTest 2: Getting variant through product`);
    const { data: variantsViaProduct } = await query.graph({
      entity: "product_variant",
      fields: [
        "id",
        "sku",
        "product.id",
        "product.title",
        "prices.id",
        "prices.amount",
        "prices.currency_code",
        "prices.price_set_id",
        "prices.price_list_id",
      ],
      filters: { sku: SKU },
    });

    if (variantsViaProduct && variantsViaProduct.length > 0) {
      const variant = variantsViaProduct[0];
      log(`✅ Via product method:`);
      log(`   Product: ${variant.product?.title}`);
      log(`   Prices: ${variant.prices?.length || 0}`);
    }

    log(`\n${"=".repeat(70)}`);
    log("📝 CONCLUSION");
    log("=".repeat(70));

    const hasPrices = variants1?.[0]?.prices?.length > 0;
    if (hasPrices) {
      log("✅ Query.graph RETURNS prices correctly");
      log("✅ Admin UI SHOULD be able to see prices");
      log("⚠️  If Admin UI still shows 'No records', it's a frontend issue");
    } else {
      log("❌ Query.graph does NOT return prices");
      log("❌ Problem is in how we're storing or linking prices");
      log("📝 Need to fix price storage/linking");
    }
    log("=".repeat(70));

    return { success: true, hasPrices };
  } catch (error: any) {
    log(`❌ Error: ${error.message}`);
    console.error(error.stack);
    throw error;
  }
}

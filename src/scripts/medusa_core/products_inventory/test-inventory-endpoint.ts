/**
 * Test inventory endpoint directly to see what it returns for EPS-MDA-60-24
 */

export default async function testInventoryEndpoint({ container }: any) {
  const logger = container.resolve("logger");
  const query = container.resolve("query");

  const log = (msg: string) => {
    console.log(msg);
    logger.info(msg);
  };

  log(`\n🔍 TESTING INVENTORY ENDPOINT DIRECTLY\n`);

  try {
    // Simulate what the endpoint does
    const { data: inventoryItems } = await query.graph({
      entity: "inventory_item",
      fields: [
        "id",
        "sku",
        "title",
        "stocked_quantity",
        "reserved_quantity",
        "variants.id",
        "variants.title",
        "variants.prices.amount",
        "variants.prices.currency_code",
        "variants.product.id",
        "variants.product.title",
        "variants.product.categories.id",
      ],
    });

    // Find EPS-MDA-60-24
    const targetItem = inventoryItems?.find(
      (item: any) => item.sku === "EPS-MDA-60-24"
    );

    if (!targetItem) {
      log(`❌ SKU not found: EPS-MDA-60-24`);
      return { success: false };
    }

    log(`✅ Found inventory item:`);
    log(`   SKU: ${targetItem.sku}`);
    log(`   Title: ${targetItem.title}`);
    log(`   Variants count: ${targetItem.variants?.length}`);

    if (targetItem.variants?.length > 0) {
      const primaryVariant = targetItem.variants[0];
      log(`\n📦 Primary Variant:`);
      log(`   ID: ${primaryVariant.id}`);
      log(`   Title: ${primaryVariant.title}`);
      log(`   Prices count: ${primaryVariant.prices?.length}`);

      if (primaryVariant.prices?.length > 0) {
        log(`\n💰 ALL PRICES in variant:`);
        primaryVariant.prices.forEach((price: any, i: number) => {
          log(`   [${i + 1}] $${price.amount} ${price.currency_code}`);
        });

        const firstPrice = primaryVariant.prices[0];
        log(`\n📌 FIRST PRICE (what endpoint returns):`);
        log(`   Amount: $${firstPrice.amount}`);
        log(`   Currency: ${firstPrice.currency_code}`);
      } else {
        log(`❌ No prices found in variant`);
      }
    }

    log(`\n${"=".repeat(70)}`);
    log("📝 EXPECTED vs ACTUAL");
    log("=".repeat(70));
    log(`Database (correct): $45.25`);
    log(
      `Endpoint returns: $${targetItem.variants?.[0]?.prices?.[0]?.amount || "NULL"}`
    );
    log(`Inventory-Advanced shows: $34.99 (OLD/WRONG)`);
    log("=".repeat(70));

    return { success: true };
  } catch (error: any) {
    log(`❌ Error: ${error.message}`);
    console.error(error.stack);
    throw error;
  }
}

/**
 * Check what query.graph returns for variant.prices (including rules field)
 */

export default async function testQueryPricesWithRules({ container }: any) {
  const logger = container.resolve("logger");
  const query = container.resolve("query");

  const SKU = "ESPFC4R4N50W0830";

  const log = (msg: string) => {
    console.log(msg);
    logger.info(msg);
  };

  log(`\n🔍 CHECKING QUERY.GRAPH PRICES WITH RULES\n`);

  try {
    // Query exactly as Admin UI would
    const { data: variants } = await query.graph({
      entity: "product_variant",
      fields: [
        "id",
        "sku",
        "prices.*", // Get all price fields including rules
      ],
      filters: { sku: SKU },
    });

    if (variants && variants.length > 0) {
      const variant = variants[0];
      log(`✅ Variant: ${variant.id}`);

      if (variant.prices && variant.prices.length > 0) {
        log(`\n📊 Prices returned by query.graph:\n`);
        variant.prices.forEach((price: any, i: number) => {
          log(`[${i + 1}] Price ID: ${price.id}`);
          log(`    Amount: $${price.amount}`);
          log(`    Currency: ${price.currency_code}`);
          log(
            `    Has 'rules' field?: ${price.rules !== undefined ? "YES" : "NO"}`
          );

          if (price.rules !== undefined) {
            log(`    Rules value: ${JSON.stringify(price.rules)}`);
            log(`    Rules is object?: ${typeof price.rules === "object"}`);
            log(
              `    Rules keys count: ${Object.keys(price.rules || {}).length}`
            );
            log(`    ⚠️  WOULD BE FILTERED BY ADMIN UI!`);
          } else {
            log(`    ✅ NO RULES - Admin UI will show this`);
          }
          log(``);
        });

        // Test the exact filter Admin UI uses
        const filteredPrices = variant.prices.filter(
          (p: any) => !Object.keys(p.rules || {}).length
        );

        log(`${"=".repeat(70)}`);
        log("📝 ADMIN UI FILTER RESULT");
        log("=".repeat(70));
        log(`Total prices: ${variant.prices.length}`);
        log(`After filter (what Admin UI shows): ${filteredPrices.length}`);

        if (filteredPrices.length === 0) {
          log(`❌ ALL PRICES FILTERED OUT!`);
          log(`   This is why Admin UI shows "No records"`);
        } else {
          log(`✅ ${filteredPrices.length} price(s) would show in Admin UI`);
        }
        log("=".repeat(70));
      } else {
        log(`❌ No prices found`);
      }
    }

    return { success: true };
  } catch (error: any) {
    log(`❌ Error: ${error.message}`);
    console.error(error.stack);
    throw error;
  }
}

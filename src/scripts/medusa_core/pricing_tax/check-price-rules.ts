/**
 * Check if prices have the 'rules' field
 */

export default async function checkPriceRules({ container }: any) {
  const logger = container.resolve("logger");
  const knex = container.resolve("__pg_connection__");

  const log = (msg: string) => {
    console.log(msg);
    logger.info(msg);
  };

  log(`\n🔍 CHECKING PRICE RULES FIELD\n`);

  try {
    // Get a sample price
    const prices = await knex("price").select("*").limit(5);

    log(`📊 Sample prices from database:`);
    prices.forEach((price: any, i: number) => {
      log(`\n[${i + 1}] Price ID: ${price.id}`);
      log(`    Amount: $${price.amount}`);
      log(`    Currency: ${price.currency_code}`);
      log(
        `    Has 'rules' field?: ${price.rules !== undefined ? "YES" : "NO"}`
      );
      log(`    Rules value: ${JSON.stringify(price.rules)}`);
      log(`    Rules type: ${typeof price.rules}`);

      if (price.rules) {
        log(`    Rules keys count: ${Object.keys(price.rules).length}`);
      }
    });

    // Check price_rule table
    const priceRules = await knex("price_rule").select("*").limit(5);

    log(`\n\n📊 Price Rules table:`);
    log(`   Total rules: ${priceRules.length}`);
    if (priceRules.length > 0) {
      priceRules.forEach((rule: any, i: number) => {
        log(`   [${i + 1}] ${JSON.stringify(rule)}`);
      });
    } else {
      log(`   ✅ No price rules (expected for simple prices)`);
    }

    log(`\n${"=".repeat(70)}`);
    log("📝 DIAGNOSIS");
    log("=".repeat(70));
    log("Admin UI filters prices with:");
    log("  variant.prices?.filter((p) => !Object.keys(p.rules || {}).length)");
    log("");
    log("This means it shows ONLY prices WITHOUT rules");
    log("=".repeat(70));

    return { success: true };
  } catch (error: any) {
    log(`❌ Error: ${error.message}`);
    console.error(error.stack);
    throw error;
  }
}

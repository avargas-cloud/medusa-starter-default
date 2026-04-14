/**
 * Investigate Database Structure for Prices
 */

export default async function investigateDbStructure({ container }: any) {
  const logger = container.resolve("logger");
  const knex = container.resolve("__pg_connection__");

  const log = (msg: string) => {
    console.log(msg);
    logger.info(msg);
  };

  log("\n🔍 INVESTIGATING DATABASE STRUCTURE\n");

  try {
    // 1. List all tables with "price" or "link" in name
    const tables = await knex.raw(`
            SELECT table_name 
            FROM information_schema.tables 
            WHERE table_schema = 'public' 
            AND (table_name LIKE '%price%' OR table_name LIKE '%link%')
            ORDER BY table_name
        `);

    log("📊 Tables with 'price' or 'link':");
    tables.rows.forEach((row: any) => {
      log(`   - ${row.table_name}`);
    });

    // 2. Check specific variant for its price data
    const SKU = "ESPFC4R4N50W0830";

    const variant = await knex("product_variant")
      .select("*")
      .where("sku", SKU)
      .first();

    if (variant) {
      log(`\n📦 Variant ${SKU}:`);
      log(`   ID: ${variant.id}`);
      log(`   Title: ${variant.title}`);

      // 3. Check for any link tables
      const linkTables = tables.rows
        .map((r: any) => r.table_name)
        .filter((t: string) => t.includes("link") && t.includes("variant"));

      log(`\n🔗 Link tables with 'variant':`);
      for (const tableName of linkTables) {
        log(`   Checking ${tableName}...`);
        try {
          const links = await knex(tableName)
            .select("*")
            .where("variant_id", variant.id)
            .whereNull("deleted_at");

          if (links.length > 0) {
            log(`     ✅ Found ${links.length} links:`);
            links.forEach((link: any) => {
              log(`        ${JSON.stringify(link)}`);
            });
          } else {
            log(`     No links found`);
          }
        } catch (err: any) {
          log(`     Error: ${err.message}`);
        }
      }

      // 4. Check price table directly
      log(`\n💲 Checking price table:`);
      const prices = await knex("price").select("*").limit(5);

      log(`   Sample prices (first 5):`);
      prices.forEach((price: any) => {
        log(
          `     $${price.amount} ${price.currency_code} - price_set_id: ${price.price_set_id}`
        );
      });
    }

    return { success: true };
  } catch (error: any) {
    log(`❌ Error: ${error.message}`);
    console.error(error.stack);
    throw error;
  }
}

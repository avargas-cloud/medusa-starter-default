/**
 * Compare prices from different sources for same SKU
 */

export default async function comparePriceSources({ container }: any) {
  const logger = container.resolve("logger");
  const query = container.resolve("query");
  const knex = container.resolve("__pg_connection__");

  const SKU = "MG-M100L12DC";

  const log = (msg: string) => {
    console.log(msg);
    logger.info(msg);
  };

  log(`\n🔍 COMPARING PRICE SOURCES FOR SKU: ${SKU}\n`);

  try {
    // 1. Get price directly from database via knex
    const variant = await knex("product_variant")
      .select("*")
      .where("sku", SKU)
      .first();

    if (!variant) {
      log(`❌ Variant not found`);
      return { success: false };
    }

    log(`✅ Variant ID: ${variant.id}`);

    // 2. Get link to price_set
    const link = await knex("product_variant_price_set")
      .select("*")
      .where("variant_id", variant.id)
      .whereNull("deleted_at")
      .first();

    if (!link) {
      log(`❌ No price_set link found`);
      return { success: false };
    }

    log(`✅ Price Set ID: ${link.price_set_id}`);

    // 3. Get ALL prices for this price_set
    const prices = await knex("price")
      .select("*")
      .where("price_set_id", link.price_set_id)
      .whereNull("deleted_at");

    log(`\n📊 PRICES IN DATABASE (via knex):`);
    prices.forEach((price: any, i: number) => {
      const label = price.price_list_id
        ? `PRICE LIST ${price.price_list_id}`
        : "DEFAULT";
      log(`   [${i + 1}] ${label}`);
      log(`       Amount: $${price.amount}`);
      log(`       Currency: ${price.currency_code}`);
      log(`       Price ID: ${price.id}`);
    });

    // 4. Get via query.graph (what scripts use)
    const { data: variantsGraph } = await query.graph({
      entity: "product_variant",
      fields: ["id", "sku", "prices.*"],
      filters: { sku: SKU },
    });

    log(`\n📊 PRICES VIA QUERY.GRAPH:`);
    if (variantsGraph?.[0]?.prices) {
      variantsGraph[0].prices.forEach((price: any, i: number) => {
        log(`   [${i + 1}] $${price.amount} ${price.currency_code}`);
      });
    }

    // 5. Get via custom inventory endpoint (what Inventory page uses)
    const inventoryPrice = await knex("product_variant as pv")
      .select(
        "pv.sku",
        "p.amount as price_amount",
        "p.currency_code as price_currency"
      )
      .leftJoin("product_variant_price_set as pvps", "pv.id", "pvps.variant_id")
      .leftJoin("price as p", function () {
        this.on("pvps.price_set_id", "=", "p.price_set_id")
          .andOnNull("p.price_list_id")
          .andOnNull("p.deleted_at");
      })
      .where("pv.sku", SKU)
      .whereNull("pvps.deleted_at")
      .first();

    log(`\n📊 PRICE VIA INVENTORY ENDPOINT LOGIC:`);
    log(`   Amount: $${inventoryPrice?.price_amount || "NULL"}`);
    log(`   Currency: ${inventoryPrice?.price_currency || "NULL"}`);

    log(`\n${"=".repeat(70)}`);
    log("📝 SUMMARY");
    log("=".repeat(70));
    log(`Total prices in price_set: ${prices.length}`);
    log(
      `Default prices: ${prices.filter((p: any) => !p.price_list_id).length}`
    );
    log(
      `Price list prices: ${prices.filter((p: any) => p.price_list_id).length}`
    );

    if (prices.length > 1) {
      log(`\n⚠️  MULTIPLE PRICES DETECTED!`);
      log(
        `   Admin UI variant detail might show wrong price if multiple exist`
      );
    }
    log("=".repeat(70));

    return { success: true };
  } catch (error: any) {
    log(`❌ Error: ${error.message}`);
    console.error(error.stack);
    throw error;
  }
}

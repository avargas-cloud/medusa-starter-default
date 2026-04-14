/**
 * Delete Zombie Prices
 * Removes prices that are not linked to any variant
 */

import { Modules } from "@medusajs/utils";

export default async function deleteZombiePrices({ container }: any) {
  const logger = container.resolve("logger");
  const pricingModuleService = container.resolve(Modules.PRICING);
  const remoteLink = container.resolve("remoteLink");
  const knex = container.resolve("__pg_connection__");

  const log = (msg: string) => {
    console.log(msg);
    logger.info(msg);
  };

  log("\n🧟 FINDING AND DELETING ZOMBIE PRICES\n");

  try {
    // 1. Get all price sets
    log("📊 Loading all price sets...");
    const allPriceSets = await pricingModuleService.listPriceSets(
      {},
      {
        relations: ["prices"],
      }
    );
    log(`   Found ${allPriceSets.length} price sets\n`);

    // 2. Get all variant→price_set links from link table
    const variantLinks = await knex("link_product_variant_price_set")
      .select("price_set_id")
      .whereNull("deleted_at");

    const linkedPriceSetIds = new Set(
      variantLinks.map((l: any) => l.price_set_id)
    );
    log(`✅ Found ${linkedPriceSetIds.size} price sets linked to variants\n`);

    // 3. Find zombie price sets (not linked to any variant)
    const zombiePriceSets: string[] = [];
    const zombiePrices: string[] = [];

    for (const priceSet of allPriceSets) {
      if (!linkedPriceSetIds.has(priceSet.id)) {
        zombiePriceSets.push(priceSet.id);

        if (priceSet.prices) {
          zombiePrices.push(...priceSet.prices.map((p: any) => p.id));
        }

        log(`🧟 Zombie Price Set: ${priceSet.id}`);
        if (priceSet.prices) {
          priceSet.prices.forEach((p: any) => {
            log(`     Price: $${p.amount} ${p.currency_code} (${p.id})`);
          });
        }
      }
    }

    log(`\n${"=".repeat(70)}`);
    log("📊 ZOMBIE ANALYSIS");
    log("=".repeat(70));
    log(`Total Price Sets: ${allPriceSets.length}`);
    log(`Linked to Variants: ${linkedPriceSetIds.size}`);
    log(`Zombie Price Sets: ${zombiePriceSets.length}`);
    log(`Zombie Prices: ${zombiePrices.length}`);
    log("=".repeat(70));

    if (zombiePriceSets.length === 0) {
      log("\n✅ No zombie prices found!");
      return { success: true, deleted: 0 };
    }

    // 4. Delete zombie price sets (will cascade to prices)
    log("\n🗑️  Deleting zombie price sets...");

    const batchSize = 50;
    let deleted = 0;

    for (let i = 0; i < zombiePriceSets.length; i += batchSize) {
      const batch = zombiePriceSets.slice(i, i + batchSize);
      await pricingModuleService.deletePriceSets(batch);
      deleted += batch.length;

      if (deleted % 50 === 0 || deleted === zombiePriceSets.length) {
        log(
          `   ✓ Deleted ${deleted}/${zombiePriceSets.length} zombie price sets...`
        );
      }
    }

    log(`\n${"=".repeat(70)}`);
    log("✅ CLEANUP COMPLETE!");
    log("=".repeat(70));
    log(`🗑️  Deleted Price Sets: ${deleted}`);
    log(`🗑️  Deleted Prices: ${zombiePrices.length}`);
    log("=".repeat(70));

    return {
      success: true,
      deletedPriceSets: deleted,
      deletedPrices: zombiePrices.length,
    };
  } catch (error: any) {
    log(`❌ Error: ${error.message}`);
    console.error(error.stack);
    throw error;
  }
}

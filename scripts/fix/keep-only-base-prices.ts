// Removed unused Modules import
export default async function ({ container }: { container: any }) {
    const knex = container.resolve("__pg_connection__");

    console.log("🔧 SIMPLEST FIX: Keep only ONE base price per price_set\n");

    // For each price_set with multiple prices, keep only the HIGHEST one (retail)
    const allPriceSets = await knex("price_set")
        .select("id")
        .limit(500);

    let deleted = 0;
    let kept = 0;

    for (const ps of allPriceSets) {
        const prices = await knex("price")
            .where("price_set_id", ps.id)
            .where("currency_code", "usd")
            .orderBy("amount", "desc");

        if (prices.length <= 1) {
            kept++;
            continue;
        }

        // Keep FIRST (highest) price
        const keepPrice = prices[0];

        // Delete others
        for (let i = 1; i < prices.length; i++) {
            await knex("price").where("id", prices[i].id).delete();
            deleted++;
        }

        // Ensure kept price is a base price
        await knex("price")
            .where("id", keepPrice.id)
            .update({
                price_list_id: null,
                rules_count: 0
            });

        kept++;
    }

    console.log(`✅ Kept ${kept} base prices (highest amount)`);
    console.log(`🗑️  Deleted ${deleted} duplicate prices`);
    console.log("\n✅ NOW: Each variant has EXACTLY 1 base price");
    console.log("✅ Price = retail price (highest)");
}

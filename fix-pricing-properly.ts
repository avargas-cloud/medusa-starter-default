// Removed unused Modules import

export default async function ({ container }: { container: any }) {
    const knex = container.resolve("__pg_connection__");

    console.log("🔧 Setting up CORRECT pricing structure...\n");

    // Step 1: Get wholesale customer group
    const wholesaleGroup = await knex("customer_group")
        .where("name", "Wholesale")
        .first();

    if (!wholesaleGroup) {
        console.log("❌ No Wholesale customer group found");
        return;
    }

    console.log("✅ Wholesale Group:", wholesaleGroup.id);

    // Step 2: Get or create wholesale price list
    let wholesalePriceList = await knex("price_list")
        .where("title", "Wholesale Pricing")
        .first();

    if (!wholesalePriceList) {
        console.log("Creating wholesale price list...");
        const [created] = await knex("price_list").insert({
            id: `plist_wholesale_${Date.now()}`,
            title: "Wholesale Pricing",
            description: "7.5% discount for wholesale customers",
            type: "sale",
            status: "active"
        }).returning("*");
        wholesalePriceList = created;
    }

    console.log("✅ Wholesale Price List:", wholesalePriceList.id);

    // Step 3: Link price list to wholesale customer group
    const existingLink = await knex("price_list_customer_group")
        .where({
            price_list_id: wholesalePriceList.id,
            customer_group_id: wholesaleGroup.id
        })
        .first();

    if (!existingLink) {
        await knex("price_list_customer_group").insert({
            price_list_id: wholesalePriceList.id,
            customer_group_id: wholesaleGroup.id
        });
        console.log("✅ Linked price list to customer group");
    }

    // Step 4: For each price_set, keep only the HIGHEST price as base, move lower to price_list
    const priceSets = await knex("price_set")
        .select("id")
        .limit(500);

    let fixed = 0;

    for (const ps of priceSets) {
        const prices = await knex("price")
            .where("price_set_id", ps.id)
            .where("currency_code", "usd")
            .orderBy("amount", "desc");

        if (prices.length <= 1) continue;

        // First price (highest) = base
        const basePrice = prices[0];

        // Update base price
        await knex("price")
            .where("id", basePrice.id)
            .update({
                price_list_id: null,
                rules_count: 0
            });

        // Other prices = wholesale (in price_list)
        for (let i = 1; i < prices.length; i++) {
            await knex("price")
                .where("id", prices[i].id)
                .update({
                    price_list_id: wholesalePriceList.id,
                    rules_count: 0
                });
        }

        fixed++;
    }

    console.log(`\n✅ Fixed ${fixed} price sets`);
    console.log("✅ Structure:");
    console.log("   - Base prices: highest amount (retail)");
    console.log("   - Wholesale prices: in price_list linked to Wholesale group");
}

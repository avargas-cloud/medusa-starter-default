import { Modules } from "@medusajs/framework/utils";

/**
 * Add wholesale prices to the wholesale price_list
 * Creates 7.5% discounted prices for all products
 */
export default async function ({ container }) {
    const knex = container.resolve("__pg_connection__");
    const pricingService = container.resolve(Modules.PRICING);

    console.log("💰 Adding wholesale prices to price_list...\n");

    // Get wholesale price list
    const priceList = await knex("price_list")
        .where("title", "Wholesale Pricing")
        .first();

    if (!priceList) {
        console.log("❌ No wholesale price list found");
        return;
    }

    console.log("✅ Wholesale Price List:", priceList.id);

    // Get all base prices
    const basePrices = await knex("price")
        .where("currency_code", "usd")
        .whereNull("price_list_id")
        .select("*")
        .limit(500);

    console.log(`\n📦 Found ${basePrices.length} base prices`);

    let created = 0;

    for (const basePrice of basePrices) {
        // Calculate 7.5% discount
        const wholesaleAmount = (parseFloat(basePrice.amount) * 0.925).toFixed(2);

        // Check if wholesale price already exists
        const existing = await knex("price")
            .where({
                price_set_id: basePrice.price_set_id,
                price_list_id: priceList.id,
                currency_code: "usd"
            })
            .first();

        if (!existing) {
            // Create wholesale price
            await knex("price").insert({
                id: `price_wholesale_${Date.now()}_${created}`,
                price_set_id: basePrice.price_set_id,
                amount: wholesaleAmount,
                raw_amount: JSON.stringify({ value: wholesaleAmount, precision: 20 }),
                currency_code: "usd",
                price_list_id: priceList.id,
                rules_count: 0
            });

            created++;
        }
    }

    console.log(`\n✅ Created ${created} wholesale prices`);
    console.log(`💵 Wholesale discount: 7.5%`);
    console.log(`📋 Example: $60.99 → $${(60.99 * 0.925).toFixed(2)}`);
}

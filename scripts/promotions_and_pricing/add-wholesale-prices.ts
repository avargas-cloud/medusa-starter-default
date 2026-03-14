// Removed unused Modules import

/**
 * Add wholesale prices to the wholesale price_list
 * Creates 7.5% discounted prices for all products
 */
export default async function ({ container }: { container: any }) {
    const knex = container.resolve("__pg_connection__");

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

    // 1. Delete any existing wholesale prices for legacy (LEG) items
    console.log("🧹 Cleaning up any existing wholesale prices for legacy (LEG) items...");
    const deletedCount = await knex("price")
        .where("price_list_id", priceList.id)
        .whereIn("price_set_id", (builder: any) => {
            builder.select("product_variant_price_set.price_set_id")
                .from("product_variant_price_set")
                .join("product_variant", "product_variant.id", "product_variant_price_set.variant_id")
                .where("product_variant.sku", "like", "LEG%");
        })
        .del();
    console.log(`🗑️  Deleted ${deletedCount} wholesale prices for legacy items`);

    // 2. Get all base prices, skipping LEG prefixed SKUs
    const basePrices = await knex("price")
        .join("product_variant_price_set", "price.price_set_id", "product_variant_price_set.price_set_id")
        .join("product_variant", "product_variant_price_set.variant_id", "product_variant.id")
        .where("price.currency_code", "usd")
        .whereNull("price.price_list_id")
        .whereNot("product_variant.sku", "like", "LEG%")
        .select("price.*", "product_variant.sku")
        .limit(2000);

    console.log(`\n📦 Found ${basePrices.length} base prices`);

    let created = 0;

    // Fast batch processing
    const BATCH_SIZE = 100;
    for (let i = 0; i < basePrices.length; i += BATCH_SIZE) {
        const batch = basePrices.slice(i, i + BATCH_SIZE);
        await Promise.all(batch.map(async (basePrice: any) => {
            const wholesaleAmount = (parseFloat(basePrice.amount) * 0.925).toFixed(2);
            const existing = await knex("price")
                .where({
                    price_set_id: basePrice.price_set_id,
                    price_list_id: priceList.id,
                    currency_code: "usd"
                }).first();
        
            if (!existing) {
                await knex("price").insert({
                    id: `price_wholesale_${Date.now()}_${Math.random().toString(36).substring(7)}`,
                    price_set_id: basePrice.price_set_id,
                    amount: wholesaleAmount,
                    raw_amount: JSON.stringify({ value: wholesaleAmount, precision: 20 }),
                    currency_code: "usd",
                    price_list_id: priceList.id,
                    rules_count: 0
                });
                created++;
            }
        }));
    }

    console.log(`\n✅ Created ${created} wholesale prices`);
    console.log(`💵 Wholesale discount: 7.5%`);
    console.log(`📋 Example: $60.99 → $${(60.99 * 0.925).toFixed(2)}`);
}

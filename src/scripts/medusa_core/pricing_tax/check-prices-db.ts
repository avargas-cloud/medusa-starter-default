import { Modules } from "@medusajs/utils";

export default async function checkPrices({ container }) {
    const query = container.resolve("query");
    const pricingModule = container.resolve(Modules.PRICING);

    // Get price_set for product
    const { data: variants } = await query.graph({
        entity: "variant",
        fields: ["id", "title", "sku", "price_set.id"],
        filters: { product_id: "product_01KGAX7RD0E6AS8JDARPEED795" }
    });

    console.log("✅ Variants found:", variants.length);

    if (variants.length === 0) {
        console.log("❌ No variants found!");
        return;
    }

    const variant = variants[0];
    console.log("\n📦 First variant:", {
        id: variant.id,
        title: variant.title,
        price_set_id: variant.price_set?.id
    });

    if (!variant.price_set?.id) {
        console.log("❌ No price_set linked!");
        return;
    }

    // Try to calculate prices
    console.log("\n💰 Calculating prices...");
    const calculated = await pricingModule.calculatePrices(
        { id: [variant.price_set.id] },
        {
            context: {
                currency_code: "usd",
                region_id: "reg_01KFS28SNF1MT1MRHRAFQ6ZGK1"
            }
        }
    );

    console.log("\n✅ Calculate Prices Result:");
    console.table(calculated);

    if (calculated.length === 0) {
        console.log("\n❌ PROBLEM: calculatePrices returned ZERO prices!");
        console.log("This means the pricing module can't find any prices for the context.");
    }
}

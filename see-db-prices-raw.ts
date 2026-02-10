import { Modules } from "@medusajs/framework/utils";

export default async function ({ container }) {
    const knex = container.resolve("__pg_connection__");
    const query = container.resolve("query");

    // Get variant with price_set
    const { data: variants } = await query.graph({
        entity: "variant",
        fields: ["id", "title", "price_set.id"],
        filters: { product_id: "product_01KGAX7RD0E6AS8JDARPEED795" }
    });

    const priceSetId = variants[0]?.price_set?.id;
    console.log("🔍 Price Set ID:", priceSetId);

    if (!priceSetId) {
        console.log("❌ No price_set found");
        return;
    }

    // Get RAW prices from DB
    const prices = await knex("price")
        .where("price_set_id", priceSetId)
        .select("*");

    console.log("\n💰 RAW Prices in DB:");
    console.table(prices.map(p => ({
        id: p.id.substring(0, 15),
        amount: p.amount,
        currency_code: p.currency_code,
        price_list_id: p.price_list_id?.substring(0, 15) || null,
        rules_count: p.rules_count
    })));

    // Check customer groups
    const groups = await knex("customer_group")
        .select("id", "name");

    console.log("\n👥 Customer Groups:");
    console.table(groups);

    // Check if prices have rules
    const rules = await knex("price_rule")
        .where("price_set_id", priceSetId)
        .leftJoin("price_rule_attribute", "price_rule.id", "price_rule_attribute.price_rule_id")
        .select("price_rule.id", "price_rule.price_id", "price_rule_attribute.attribute", "price_rule_attribute.value");

    if (rules.length > 0) {
        console.log("\n⚠️  Price Rules Found (THIS MIGHT BE THE PROBLEM):");
        console.table(rules);
    } else {
        console.log("\n✅ No price_rules (good)");
    }
}

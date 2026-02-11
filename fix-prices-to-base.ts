// Removed unused Modules import
export default async function ({ container }: { container: any }) {
    const knex = container.resolve("__pg_connection__");

    console.log("🔍 Updating all prices: removing price_list_id and setting rules_count=0...");

    const result = await knex("price")
        .update({
            price_list_id: null,
            rules_count: 0
        });

    console.log(`✅ Updated ${result} prices`);
    console.log("\n✅ All prices are now BASE prices (no rules, no price_list)");
    console.log("✅ calculatePrices() should now work!");
}

// Removed unused Modules import
export default async function ({ container }: { container: any }) {
    const knex = container.resolve("__pg_connection__");

    console.log("🔍 Deleting ALL price_rules...");

    const result = await knex("price_rule").delete();

    console.log(`✅ Deleted ${result} price_rules`);
    console.log("\n✅ Now prices should be accessible to calculatePrices()");
}

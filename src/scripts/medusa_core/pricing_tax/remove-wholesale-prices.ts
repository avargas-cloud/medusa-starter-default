// Remove wholesale prices from price_list
// Removes prices with price_list_id set
export default async function ({ container }: { container: any }) {
  const knex = container.resolve("__pg_connection__");

  console.log("🗑️  Removing wholesale prices from price_list...\n");

  // Get wholesale price list
  const priceList = await knex("price_list")
    .where("title", "Wholesale Pricing")
    .first();

  if (!priceList) {
    console.log("❌ No wholesale price list found");
    return;
  }

  console.log("✅ Wholesale Price List:", priceList.id);

  // Delete all prices in this price_list
  const deleted = await knex("price")
    .where("price_list_id", priceList.id)
    .delete();

  console.log(`\n🗑️  Deleted ${deleted} wholesale prices`);
  console.log(`✅ RESULT: Only base retail prices remain`);
  console.log(`📋 All customers will see retail prices ($60.99)`);
}

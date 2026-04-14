export default async function ({ container }: { container: any }) {
  const knex = container.resolve("__pg_connection__");

  console.log("📊 Fetching RAW pricing data from DB...\\n");

  // Get all prices with price_set info
  const prices = await knex("price")
    .leftJoin("price_set", "price.price_set_id", "price_set.id")
    .select(
      "price.id as price_id",
      "price.amount",
      "price.currency_code",
      "price.price_list_id",
      "price.rules_count",
      "price_set.id as price_set_id"
    )
    .limit(50);

  console.log(`\\n📦 Found ${prices.length} prices\\n`);

  console.table(
    prices.map((p: any) => ({
      id: p.price_id?.substring(0, 15),
      amount: p.amount,
      currency: p.currency_code,
      price_list: p.price_list_id?.substring(0, 15) || null,
      rules: p.rules_count,
      price_set: p.price_set_id?.substring(0, 15),
    }))
  );

  // Check customer groups
  const groups = await knex("customer_group").select("id", "name");

  console.log("\\n👥 Customer Groups:");
  console.table(groups);
}

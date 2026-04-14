export default async function ({ container }: any) {
  const knex = container.resolve("__pg_connection__");
  const productId = "prod_ul-freecut-cob-led-strip-single-color-bright-output";

  console.log("🗑️  HARD DELETE SOFT-DELETED LINKS");
  console.log("=".repeat(80));

  // 1. Find soft-deleted links
  const softDeleted = await knex(
    "product_product_productattributes_attribute_value"
  )
    .select("*")
    .where("product_id", productId)
    .whereNotNull("deleted_at");

  console.log(`\n📊 Found ${softDeleted.length} soft-deleted links`);

  if (softDeleted.length === 0) {
    console.log("✅ No soft-deleted links to clean!");
    console.log("=".repeat(80));
    return;
  }

  // 2. Get value details for logging
  const valueIds = softDeleted.map((l: any) => l.attribute_value_id);
  const query = container.resolve("query");

  const { data: values } = await query.graph({
    entity: "attribute_value",
    fields: ["id", "value", "attribute_key.handle"],
    filters: { id: valueIds },
  });

  console.log("\n🗑️  Will PERMANENTLY delete:");
  values.forEach((v: any) => {
    console.log(`   - ${v.attribute_key.handle}: ${v.value}`);
  });

  // 3. HARD DELETE (permanent)
  const deleted = await knex(
    "product_product_productattributes_attribute_value"
  )
    .where("product_id", productId)
    .whereNotNull("deleted_at")
    .del(); // ← HARD DELETE

  console.log(`\n✅ Permanently deleted ${deleted} soft-deleted link(s)`);
  console.log("=".repeat(80));
}

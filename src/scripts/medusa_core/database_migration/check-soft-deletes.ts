export default async function ({ container }: any) {
  const knex = container.resolve("__pg_connection__");
  const productId = "prod_ul-freecut-cob-led-strip-single-color-bright-output";

  console.log("🔍 CHECKING SOFT DELETES IN LINK TABLE");
  console.log("=".repeat(80));

  // 1. All links (including soft-deleted)
  const allLinks = await knex(
    "product_product_productattributes_attribute_value"
  )
    .select("attribute_value_id", "deleted_at")
    .where("product_id", productId);

  console.log(`\n📊 Total links (including soft-deleted): ${allLinks.length}`);

  const active = allLinks.filter((l: any) => !l.deleted_at);
  const deleted = allLinks.filter((l: any) => l.deleted_at);

  console.log(`✅ Active links: ${active.length}`);
  console.log(`❌ Soft-deleted links: ${deleted.length}`);

  if (deleted.length > 0) {
    const deletedIds = deleted.map((l: any) => l.attribute_value_id);
    const query = container.resolve("query");

    const { data: deletedValues } = await query.graph({
      entity: "attribute_value",
      fields: ["id", "value", "attribute_key.handle"],
      filters: { id: deletedIds },
    });

    console.log(`\n❌ Soft-deleted values:`);
    deletedValues.forEach((v: any) => {
      console.log(`   - ${v.attribute_key.handle}: ${v.value}`);
    });
  }

  console.log("=".repeat(80));
}

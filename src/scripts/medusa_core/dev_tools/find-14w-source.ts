import { ExecArgs } from "@medusajs/framework/types";

export default async function ({ container }: ExecArgs) {
  const knex = container.resolve("__pg_connection__");

  console.log("\n🔍 FINDING WHERE 14W COMES FROM");
  console.log("=".repeat(80));

  // 1. Get the 14W value ID
  const value14W = await knex("attribute_value")
    .select("id", "value", "attribute_key_id")
    .where("value", "14W")
    .first();

  if (!value14W) {
    console.log("❌ 14W value not found in DB");
    return;
  }

  console.log(`\n✅ Found 14W: ${value14W.id}`);

  // 2. Get the key
  const key = await knex("attribute_key")
    .select("handle")
    .where("id", value14W.attribute_key_id)
    .first();

  console.log(`   Key: ${key?.handle}`);

  // 3. Find ALL links to this value (active AND soft-deleted)
  const allLinks = await knex(
    "product_product_productattributes_attribute_value"
  )
    .where("attribute_value_id", value14W.id)
    .orderBy("created_at", "desc");

  console.log(`\n📊 Total links to 14W: ${allLinks.length}`);

  for (const link of allLinks) {
    const product = await knex("product")
      .select("id", "title", "status")
      .where("id", link.product_id)
      .first();

    const status = link.deleted_at ? "❌ SOFT-DELETED" : "✅ ACTIVE";
    console.log(`\n   ${status}`);
    console.log(`   Product: ${product?.title}`);
    console.log(`   Status: ${product?.status}`);
    console.log(`   Created: ${link.created_at}`);
    if (link.deleted_at) {
      console.log(`   Deleted: ${link.deleted_at}`);
    }
  }

  console.log("\n" + "=".repeat(80));
  console.log("\n💡 CONCLUSION:");
  if (allLinks.some((l) => !l.deleted_at)) {
    console.log("   14W is ACTIVE on at least one product");
    console.log("   This is why it appears in filters (correct behavior)");
  } else {
    console.log("   14W is ONLY soft-deleted");
    console.log("   This means the filter is NOT working correctly");
    console.log("   Need to check filter-generator.ts");
  }
  console.log();
}

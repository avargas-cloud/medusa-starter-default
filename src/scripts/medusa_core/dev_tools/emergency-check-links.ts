import { ExecArgs } from "@medusajs/framework/types";

export default async function ({ container }: ExecArgs) {
  const knex = container.resolve("__pg_connection__");

  console.log("\n🔍 CHECKING ALL ATTRIBUTE LINKS");
  console.log("=".repeat(80));

  const productId = "prod_ul-freecut-cob-led-strip-single-color-bright-output";

  // Check all links for this product
  const allLinks = await knex(
    "product_product_productattributes_attribute_value"
  )
    .select("*")
    .where("product_id", productId);

  console.log(`\n📊 Total links for product: ${allLinks.length}`);

  if (allLinks.length === 0) {
    console.log("❌ NO LINKS FOUND - ALL ATTRIBUTES WERE DELETED!\n");
    return;
  }

  // Show all links
  for (const link of allLinks) {
    const value = await knex("attribute_value")
      .select("value", "attribute_key_id")
      .where("id", link.attribute_value_id)
      .first();

    const key = await knex("attribute_key")
      .select("handle")
      .where("id", value?.attribute_key_id)
      .first();

    console.log(
      `\n   ${key?.handle || "unknown"}: ${value?.value || "unknown"}`
    );
    console.log(`      value_id: ${link.attribute_value_id}`);
    console.log(`      deleted_at: ${link.deleted_at || "NULL (ACTIVE)"}`);
  }

  console.log("\n" + "=".repeat(80) + "\n");
}

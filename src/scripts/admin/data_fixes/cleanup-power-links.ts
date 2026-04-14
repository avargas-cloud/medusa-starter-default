import { ExecArgs } from "@medusajs/framework";

export default async function ({ container }: ExecArgs) {
  const knex = container.resolve("__pg_connection__");
  const query = container.resolve("query");

  console.log(`\n🧹 CLEANING ORPHANED POWER CONSUMPTION LINKS\n`);
  console.log("=".repeat(80));

  // Get Power Consumption attribute key
  const { data: powerKey } = await query.graph({
    entity: "attribute_key",
    fields: ["id", "handle"],
    filters: { handle: ["power-consumption"] },
  });

  const keyId = powerKey[0].id;
  console.log(`Power Consumption Key ID: ${keyId}\n`);

  // Get ALL attribute values for this key
  const { data: allValues } = await query.graph({
    entity: "attribute_value",
    fields: ["id", "value"],
    filters: { attribute_key_id: keyId },
  });

  const valueIds = allValues.map((v) => v.id);

  // Get ALL products
  const { data: products } = await query.graph({
    entity: "product",
    fields: ["id", "title"],
    filters: {},
  });

  console.log(`Found ${products.length} products`);
  console.log(`Found ${allValues.length} Power Consumption values\n`);

  let totalRemoved = 0;

  // For EACH product, find duplicate Power Consumption links
  for (const product of products) {
    // Get all Power Consumption links for this product
    const links = await knex(
      "product_product_productattributes_attribute_value"
    )
      .where({ product_id: product.id })
      .whereIn("attribute_value_id", valueIds)
      .select("*")
      .orderBy("created_at", "desc"); // Latest first

    if (links.length <= 1) continue; // No duplicates

    // Keep the FIRST (latest) link, remove the rest
    const toKeep = links[0];
    const toRemove = links.slice(1);

    const keepValue = allValues.find((v) => v.id === toKeep.attribute_value_id);
    const removeValues = toRemove.map((l) => {
      const v = allValues.find((val) => val.id === l.attribute_value_id);
      return v?.value || "UNKNOWN";
    });

    console.log(`\n📦 ${product.title}:`);
    console.log(`   ✅ Keep: ${keepValue?.value}`);
    console.log(
      `   ❌ Remove: ${removeValues.join(", ")} (${toRemove.length} links)`
    );

    // Delete the orphaned links
    await knex("product_product_productattributes_attribute_value")
      .whereIn(
        "id",
        toRemove.map((l) => l.id)
      )
      .del();

    totalRemoved += toRemove.length;
  }

  console.log(`\n` + "=".repeat(80));
  console.log(`\n✅ Cleanup complete`);
  console.log(`   Removed ${totalRemoved} orphaned links\n`);
}

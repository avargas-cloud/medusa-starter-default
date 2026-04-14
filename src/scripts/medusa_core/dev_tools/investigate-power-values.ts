import { ExecArgs } from "@medusajs/medusa";

export default async function ({ container }: ExecArgs) {
  const query = container.resolve("query");

  const CATEGORY_ID = "pcat_led-strips-white";

  console.log(`\n🔍 INVESTIGATING CATEGORY: ${CATEGORY_ID}\n`);
  console.log("=".repeat(80));

  // 1. Get all products in this category
  const { data: products } = await query.graph({
    entity: "product",
    fields: ["id", "title", "status"],
    filters: {
      categories: { id: [CATEGORY_ID] },
    },
  });

  console.log(`\n📦 Products in category: ${products.length}`);
  products.forEach((p: any, i: number) => {
    console.log(`   ${i + 1}. ${p.title} (${p.status})`);
    console.log(`      ID: ${p.id}`);
  });

  // 2. Get Power Consumption attribute key ID
  const { data: powerKey } = await query.graph({
    entity: "attribute_key",
    fields: ["id", "handle"],
    filters: { handle: ["power-consumption"] },
  });

  if (!powerKey || powerKey.length === 0) {
    console.log("\n❌ Power Consumption attribute not found");
    return;
  }

  const attributeKeyId = powerKey[0].id;
  console.log(`\n🔑 Power Consumption Key ID: ${attributeKeyId}`);

  // 3. For each product, get its Power Consumption values
  console.log(`\n📊 POWER CONSUMPTION VALUES PER PRODUCT:`);
  console.log("=".repeat(80));

  for (const product of products) {
    // Get all attribute values for this product
    const { data: links } = await query.graph({
      entity: "product_attribute_value",
      fields: [
        "attribute_value_id",
        "attribute_value.value",
        "attribute_value.attribute_key_id",
      ],
      filters: { product_id: product.id },
    });

    // Filter for Power Consumption values
    const powerValues = links.filter(
      (l: any) => l.attribute_value?.attribute_key_id === attributeKeyId
    );

    console.log(`\n   ${product.title}:`);
    if (powerValues.length === 0) {
      console.log(`      ❌ NO Power Consumption values`);
    } else {
      powerValues.forEach((v: any) => {
        console.log(`      ✅ ${v.attribute_value.value}`);
      });
    }
  }

  console.log(`\n` + "=".repeat(80));
  console.log(`\n✅ Investigation complete\n`);
}

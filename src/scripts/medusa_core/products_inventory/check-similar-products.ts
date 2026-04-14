import { ExecArgs } from "@medusajs/framework/types";

export default async function ({ container }: ExecArgs) {
  const query = container.resolve("query");

  console.log("\n🔍 CHECKING SIMILAR PRODUCTS FOR REFERENCE");
  console.log("=".repeat(80));

  // Get products in same category
  const { data: products } = await query.graph({
    entity: "product",
    fields: ["id", "title", "status"],
    filters: {
      categories: {
        id: ["pcat_led-strips-white"],
      },
    },
  });

  console.log(`\n📦 Found ${products.length} products in WHITE LED STRIPS:\n`);

  for (const product of products) {
    console.log(`\n   ${product.title} (${product.status})`);
    console.log(`   ID: ${product.id}`);

    // Get attributes for this product
    const { data: attributes } = await query.graph({
      entity: "product",
      fields: [
        "attribute_values.value",
        "attribute_values.attribute_key.handle",
      ],
      filters: { id: product.id },
    });

    const attrValues = attributes[0]?.attribute_values || [];

    if (attrValues.length > 0) {
      console.log(`   Attributes (${attrValues.length}):`);
      const grouped = attrValues.reduce((acc: any, av: any) => {
        const handle = av.attribute_key?.handle || "unknown";
        if (!acc[handle]) acc[handle] = [];
        acc[handle].push(av.value);
        return acc;
      }, {});

      Object.entries(grouped).forEach(([key, values]: [string, any]) => {
        console.log(`      - ${key}: ${values.join(", ")}`);
      });
    } else {
      console.log(`      ⚠️  NO ATTRIBUTES`);
    }
  }

  console.log("\n" + "=".repeat(80) + "\n");
}

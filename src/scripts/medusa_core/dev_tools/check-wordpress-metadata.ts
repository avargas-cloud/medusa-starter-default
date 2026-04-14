import { ExecArgs } from "@medusajs/framework/types";

export default async function ({ container }: ExecArgs) {
  const query = container.resolve("query");

  console.log("\n🔍 CHECKING WORDPRESS METADATA");
  console.log("=".repeat(80));

  const productId = "prod_ul-freecut-cob-led-strip-single-color-bright-output";

  const { data: products } = await query.graph({
    entity: "product",
    fields: ["id", "title", "metadata"],
    filters: { id: productId },
  });

  const product = products[0];

  console.log(`\n📦 Product: ${product.title}`);
  console.log(`\n📋 Full Metadata:`);
  console.log(JSON.stringify(product.metadata, null, 2));

  // Check for WooCommerce attributes
  if (product.metadata?.woocommerce_attributes) {
    console.log(`\n✅ Found WooCommerce attributes in metadata!`);
    console.log(
      JSON.stringify(product.metadata.woocommerce_attributes, null, 2)
    );
  } else {
    console.log(`\n⚠️  No woocommerce_attributes found in metadata`);
  }

  console.log("\n" + "=".repeat(80) + "\n");
}

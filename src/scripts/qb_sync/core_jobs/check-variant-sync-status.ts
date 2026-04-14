import { ExecArgs } from "@medusajs/framework/types";

export default async function ({ container }: ExecArgs) {
  const query = container.resolve("query");

  console.log("\n🔍 CHECKING VARIANT ATTRIBUTE STATUS");
  console.log("=".repeat(80));

  const productId = "prod_ul-freecut-cob-led-strip-single-color-bright-output";

  // 1. Get product with metadata, options, and variants
  const { data: products } = await query.graph({
    entity: "product",
    fields: [
      "id",
      "title",
      "metadata",
      "options.id",
      "options.title",
      "options.values.value",
      "variants.id",
      "variants.title",
      "variants.options.value",
      "variants.options.option_id",
    ],
    filters: { id: productId },
  });

  const product = products[0];

  console.log(`\n📦 Product: ${product.title}`);
  console.log(
    `\n🔧 Variant Attributes in Metadata:`,
    product.metadata?.variant_attributes || "None"
  );

  // Check WooCommerce metadata for variant attributes
  const wc_attributes = product.metadata?.wc_attributes || [];
  const variantAttrs = wc_attributes.filter(
    (attr: any) => attr.variation === true
  );

  console.log(`\n🔍 WooCommerce Variant Attributes:`);
  variantAttrs.forEach((attr: any) => {
    console.log(`   - ${attr.name} (${attr.slug})`);
    console.log(`     Options: ${attr.options.join(", ")}`);
  });

  console.log(`\n📋 Product Options (${product.options.length}):`);
  product.options.forEach((opt: any) => {
    const values = opt.values?.map((v: any) => v.value) || [];
    console.log(`   - ${opt.title} (${opt.id})`);
    console.log(`     Values: ${values.join(", ") || "None"}`);
  });

  console.log(`\n🎯 Variants (${product.variants.length}):`);
  product.variants.forEach((variant: any) => {
    const optionValues = variant.options?.map((o: any) => o.value) || [];
    console.log(`   - ${variant.title} (${variant.id})`);
    console.log(`     Options: ${optionValues.join(", ") || "None"}`);
  });

  console.log("\n" + "=".repeat(80));
  console.log("\n❓ EXPECTED:");
  console.log("   - Product should have 1 Option: 'Color Options'");
  console.log("   - Option should have 3 values: 3000K, 4000K, 6000K");
  console.log("   - Each variant should link to one of these option values");
  console.log("\n❓ IF MISSING:");
  console.log("   Run: npx medusa exec src/scripts/sync-variant-attributes.ts");
  console.log();
}

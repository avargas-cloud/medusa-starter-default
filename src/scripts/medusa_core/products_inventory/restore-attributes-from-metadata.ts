import { ExecArgs } from "@medusajs/framework/types";
import { Modules } from "@medusajs/utils";

const PRODUCT_ATTRIBUTES_MODULE = "productAttributes";

export default async function ({ container }: ExecArgs) {
  const query = container.resolve("query");
  const remoteLink = container.resolve("remoteLink");

  console.log("\n🔧 RESTORING ATTRIBUTES FROM WOOCOMMERCE METADATA");
  console.log("=".repeat(80));

  const productId = "prod_ul-freecut-cob-led-strip-single-color-bright-output";

  // 1. Get product metadata
  const { data: products } = await query.graph({
    entity: "product",
    fields: ["id", "title", "metadata"],
    filters: { id: productId },
  });

  const product = products[0];
  const wooAttributes = product.metadata?.wc_attributes || [];

  console.log(`\n📦 Product: ${product.title}`);
  console.log(
    `📋 Found ${wooAttributes.length} WooCommerce attributes in metadata\n`
  );

  if (wooAttributes.length === 0) {
    console.log("⚠️  No attributes to restore\n");
    return;
  }

  // 2. Get all attribute keys and values using remoteQuery
  const remoteQuery = container.resolve("remoteQuery");

  const allKeys = await remoteQuery({
    entryPoint: "attribute_key",
    fields: ["id", "handle"],
    variables: {},
  });

  const allValues = await remoteQuery({
    entryPoint: "attribute_value",
    fields: ["id", "value", "attribute_key_id"],
    variables: {},
  });

  // Create lookup maps
  const keyByHandle = new Map();
  allKeys.forEach((key: any) => {
    keyByHandle.set(key.handle, key);
  });

  const valuesByKeyId = new Map();
  allValues.forEach((value: any) => {
    if (!valuesByKeyId.has(value.attribute_key_id)) {
      valuesByKeyId.set(value.attribute_key_id, []);
    }
    valuesByKeyId.get(value.attribute_key_id).push(value);
  });

  const valueIdsToLink: string[] = [];
  const notFound: any[] = [];

  // 3. Match WooCommerce attributes to Medusa attribute values
  for (const wooAttr of wooAttributes) {
    const handle = wooAttr.slug.replace("pa_", ""); // Remove pa_ prefix
    const key = keyByHandle.get(handle);

    if (!key) {
      console.log(`⚠️  Attribute key not found: ${handle}`);
      notFound.push({ handle, options: wooAttr.options });
      continue;
    }

    // Match each option value
    const keyValues = valuesByKeyId.get(key.id) || [];
    for (const optionValue of wooAttr.options) {
      const matchingValue = keyValues.find((v: any) => v.value === optionValue);

      if (matchingValue) {
        valueIdsToLink.push(matchingValue.id);
        console.log(`   ✅ ${handle}: ${optionValue}`);
      } else {
        console.log(`   ⚠️  Value not found for ${handle}: ${optionValue}`);
        notFound.push({ handle, value: optionValue });
      }
    }
  }

  console.log(`\n📊 Summary:`);
  console.log(`   - Total attributes to restore: ${valueIdsToLink.length}`);
  console.log(`   - Not found: ${notFound.length}`);

  if (notFound.length > 0) {
    console.log(`\n⚠️  Some attributes could not be matched:`);
    notFound.forEach((item) => {
      console.log(`      - ${item.handle}: ${item.value || item.options}`);
    });
  }

  if (valueIdsToLink.length === 0) {
    console.log("\n⚠️  No attributes to link\n");
    return;
  }

  // 4. Create links
  console.log(`\n🔗 Creating ${valueIdsToLink.length} attribute links...`);

  const linksToCreate = valueIdsToLink.map((valueId) => ({
    [Modules.PRODUCT]: { product_id: productId },
    [PRODUCT_ATTRIBUTES_MODULE]: { attribute_value_id: valueId },
  }));

  await remoteLink.create(linksToCreate);

  console.log(`✅ Successfully restored ${valueIdsToLink.length} attributes`);

  console.log("\n" + "=".repeat(80));
  console.log("✅ Restoration complete!");
  console.log("\n💡 Next steps:");
  console.log("   1. Refresh the product page in Admin UI");
  console.log("   2. Verify all attributes are showing");
  console.log("   3. Hard refresh the filter page to see updated filters");
  console.log();
}

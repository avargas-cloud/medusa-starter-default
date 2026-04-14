import { Modules } from "@medusajs/utils";

export default async function ({ container }: any) {
  const query = container.resolve("query");
  const productId = "prod_ul-freecut-cob-led-strip-single-color-bright-output";

  console.log("🔍 TOTAL ATTRIBUTE LINKS");
  console.log("=".repeat(80));

  const { data: links } = await query.graph({
    entity: "product_attribute_value",
    fields: ["attribute_value_id"],
    filters: { product_id: productId },
  });

  const valueIds = links.map((l: any) => l.attribute_value_id);

  const { data: values } = await query.graph({
    entity: "attribute_value",
    fields: ["id", "value", "attribute_key_id", "attribute_key.handle"],
    filters: { id: valueIds },
  });

  const byKey = new Map<string, any[]>();
  values.forEach((v: any) => {
    const handle = v.attribute_key.handle;
    if (!byKey.has(handle)) {
      byKey.set(handle, []);
    }
    byKey.get(handle)!.push(v.value);
  });

  console.log(`\n📊 Total links: ${links.length}`);
  console.log(`📊 Unique keys: ${byKey.size}\n`);

  byKey.forEach((vals, handle) => {
    console.log(`${handle}: ${vals.length} value(s)`);
    if (vals.length > 1) {
      console.log(`  → ${vals.join(", ")}`);
    }
  });

  console.log("=".repeat(80));
}

import { Modules } from "@medusajs/utils";

export default async function debugPowerConsumption({ container }: any) {
  const query = container.resolve("query");
  const productId = "prod_ul-freecut-cob-led-strip-single-color-bright-output";

  console.log("🔍 DEBUG: Power Consumption Values");
  console.log("=".repeat(80));

  // 1. Get current attribute links
  const { data: links } = await query.graph({
    entity: "product_attribute_value",
    fields: ["attribute_value_id"],
    filters: { product_id: productId },
  });

  const valueIds = links.map((l: any) => l.attribute_value_id);

  // 2. Get full value details
  const { data: values } = await query.graph({
    entity: "attribute_value",
    fields: ["id", "value", "attribute_key_id", "attribute_key.handle"],
    filters: { id: valueIds },
  });

  // 3. Filter Power Consumption values
  const powerValues = values.filter(
    (v: any) => v.attribute_key.handle === "power-consumption"
  );

  console.log(`\n📊 Found ${powerValues.length} Power Consumption values:`);
  powerValues.forEach((v: any) => {
    console.log(`   - ${v.value} (ID: ${v.id})`);
  });

  console.log("=".repeat(80));
}

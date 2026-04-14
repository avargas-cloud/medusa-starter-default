export default async function ({ container }: any) {
  const query = container.resolve("query");

  // Get LED Strips category
  const { data: categories } = await query.graph({
    entity: "product_category",
    fields: ["id", "name", "handle", "metadata"],
    filters: { handle: "led-strips" },
  });

  const category = categories[0];
  console.log("\n📦 Category:", category.name);
  console.log("━".repeat(60));

  if (category.metadata?.filter_config) {
    const config = category.metadata.filter_config;
    console.log("\n✅ filter_config found:");
    console.log("  - active_filters:", config.active_filters);
    console.log("  - override_inheritance:", config.override_inheritance);

    // Check format
    const first = config.active_filters?.[0];
    if (typeof first === "string") {
      console.log("  - Format: string[] ✅");
      console.log("  - First ID:", first);
    } else if (typeof first === "object") {
      console.log("  - Format: object[] ✅");
      console.log("  - First object:", first);
    }
  }

  if (category.metadata?.available_attributes) {
    console.log("\n✅ available_attributes found:");
    console.log("  - Count:", category.metadata.available_attributes.length);
    console.log(
      "  - First 3:",
      category.metadata.available_attributes.slice(0, 3)
    );
  }

  // Now get attributes from endpoint data
  console.log("\n📋 Fetching attributes from attribute_key table...");

  const { data: attrKeys } = await query.graph({
    entity: "attribute_key",
    fields: ["id", "handle", "label"],
    filters: {},
  });

  console.log("  - Total attribute_keys:", attrKeys.length);
  console.log(
    "  - Sample IDs:",
    attrKeys.slice(0, 3).map((a: any) => ({ id: a.id, handle: a.handle }))
  );

  // Check if any active filter IDs match attribute_key IDs
  if (category.metadata?.filter_config?.active_filters) {
    const activeIds = category.metadata.filter_config.active_filters;
    const firstActiveId =
      typeof activeIds[0] === "string"
        ? activeIds[0]
        : activeIds[0]?.attribute_id;

    const match = attrKeys.find((k: any) => k.id === firstActiveId);

    if (match) {
      console.log("\n✅ ID MATCH FOUND!");
      console.log("  - Active filter ID:", firstActiveId);
      console.log("  - Matches attribute:", match.label);
    } else {
      console.log("\n❌ NO MATCH!");
      console.log("  - Active filter ID:", firstActiveId);
      console.log("  - Not found in attribute_key table");
      console.log(
        "\n🔍 Possible issue: IDs in filter_config don't match attribute_key IDs"
      );
    }
  }
}

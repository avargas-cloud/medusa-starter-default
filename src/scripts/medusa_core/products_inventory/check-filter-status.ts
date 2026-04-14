export default async function ({ container }: any) {
  const query = container.resolve("query");

  console.log("\n📊 CATEGORY FILTER STATUS REPORT");
  console.log("=".repeat(80));

  // Get all categories with filter_config
  const { data: allCategories } = await query.graph({
    entity: "product_category",
    fields: ["id", "handle", "name", "metadata", "parent_category_id"],
    filters: {},
  });

  const categoriesWithFilters = allCategories.filter(
    (cat: any) => cat.metadata?.filter_config?.active_filters?.length > 0
  );

  console.log(
    `\n📂 Found ${categoriesWithFilters.length} categories with filter configurations\n`
  );

  // Count descendants
  const descendantCounts = new Map();
  for (const cat of categoriesWithFilters) {
    const descendants = allCategories.filter((c: any) => {
      let current = c;
      while (current.parent_category_id) {
        if (current.parent_category_id === cat.id) return true;
        current = allCategories.find(
          (p: any) => p.id === current.parent_category_id
        );
        if (!current) break;
      }
      return false;
    });
    descendantCounts.set(cat.id, descendants.length);
  }

  // Check if filters exist in metadata
  for (const cat of categoriesWithFilters) {
    const descendants = descendantCounts.get(cat.id) || 0;
    const hasFilters =
      cat.metadata?.filters &&
      Array.isArray(cat.metadata.filters) &&
      cat.metadata.filters.length > 0;
    const filterCount = hasFilters ? cat.metadata.filters.length : 0;
    const configuredCount = cat.metadata.filter_config.active_filters.length;

    const status = hasFilters ? "✅" : "❌";
    const size =
      descendants > 50
        ? "🔴 LARGE"
        : descendants > 10
          ? "🟡 MEDIUM"
          : "🟢 SMALL";

    console.log(`${status} ${cat.name}`);
    console.log(`   Handle: ${cat.handle}`);
    console.log(`   Size: ${size} (${descendants} descendants)`);
    console.log(`   Configured: ${configuredCount} filters`);
    console.log(`   Generated: ${filterCount} filters`);

    if (!hasFilters) {
      console.log(`   ⚠️  NEEDS SYNC`);
    }

    console.log();
  }

  const needsSync = categoriesWithFilters.filter(
    (c) => !c.metadata?.filters || c.metadata.filters.length === 0
  );

  console.log("=".repeat(80));
  console.log(`\n📋 SUMMARY:`);
  console.log(`   Total: ${categoriesWithFilters.length}`);
  console.log(`   Synced: ${categoriesWithFilters.length - needsSync.length}`);
  console.log(`   Needs Sync: ${needsSync.length}`);

  if (needsSync.length > 0) {
    console.log(`\n⚠️  Categories needing sync:`);
    needsSync.forEach((c) => {
      const descendants = descendantCounts.get(c.id) || 0;
      if (descendants > 50) {
        console.log(`   - ${c.name} (${c.handle}) - USE QUICK-FIX`);
      } else {
        console.log(`   - ${c.name} (${c.handle})`);
      }
    });
  }
}

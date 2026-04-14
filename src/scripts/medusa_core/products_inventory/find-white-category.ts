export default async function ({ container }: any) {
  const query = container.resolve("query");

  const { data: categories } = await query.graph({
    entity: "product_category",
    fields: ["id", "handle", "name"],
    filters: {},
  });

  console.log("📂 ALL CATEGORIES:");
  categories
    .filter(
      (c: any) =>
        c.name.toLowerCase().includes("white") ||
        c.name.toLowerCase().includes("led")
    )
    .forEach((c: any) => {
      console.log(`   ${c.handle} → ${c.name}`);
    });
}

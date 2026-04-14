import { ExecArgs } from "@medusajs/framework/types";
import { Modules } from "@medusajs/utils";
import { IProductModuleService } from "@medusajs/framework/types";

export default async function listCategories({ container }: ExecArgs) {
  const productService: IProductModuleService = container.resolve(
    Modules.PRODUCT
  );

  console.log("\n📂 LISTING ALL CATEGORIES...");
  console.log("─".repeat(80));

  const [categories] = await productService.listAndCountProductCategories(
    {},
    { take: 50 }
  );

  if (!categories || categories.length === 0) {
    console.log("❌ No categories found");
    return;
  }

  // Group by parent
  const roots = categories.filter((c) => !c.parent_category_id);
  const children = categories.filter((c) => c.parent_category_id);

  for (const root of roots) {
    console.log(`\n📁 ${root.name}`);
    console.log(`   ID: ${root.id}`);
    console.log(`   Handle: ${root.handle}`);

    const kids = children.filter((c) => c.parent_category_id === root.id);
    for (const kid of kids) {
      console.log(`\n  └─ ${kid.name}`);
      console.log(`     ID: ${kid.id}`);
      console.log(`     Handle: ${kid.handle}`);
    }
  }

  console.log("\n" + "─".repeat(80));
  console.log(`\n✅ Showing ${categories.length} categories`);
  console.log(
    `\n💡 Copy a category ID and paste it into verify-category-filters.ts\n`
  );
}

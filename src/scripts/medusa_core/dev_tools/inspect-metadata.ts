import { ExecArgs } from "@medusajs/framework/types";

/**
 * Inspect products to find where WC ID is stored
 * Run with: npx medusa exec ./src/scripts/inspect-metadata.ts
 */
export default async function inspectMetadata({ container }: ExecArgs) {
  const query = container.resolve("query");

  console.log("\n🔍 Inspecting Product Metadata...\n");

  const { data: products } = await query.graph({
    entity: "product",
    fields: ["id", "title", "metadata"],
    pagination: { take: 5 },
  });

  products.forEach((p: any) => {
    console.log(`Product: ${p.title}`);
    console.log(`Metadata:`, p.metadata);
    console.log("---");
  });
}

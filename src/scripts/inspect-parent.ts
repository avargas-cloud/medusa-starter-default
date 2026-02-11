import { ExecArgs } from "@medusajs/framework/types";

/**
 * Inspect a Product (Parent) to see if it has dimensions we can copy to variants
 * Run with: npx medusa exec ./src/scripts/inspect-parent.ts
 */
export default async function inspectParent({ container }: ExecArgs) {
    const query = container.resolve("query");

    console.log("\n🔍 Inspecting Product Parent of LPV-100-24...\n");

    // 1. Find the product containing variant LPV-100-24
    const { data: products } = await query.graph({
        entity: "product",
        fields: ["id", "title", "weight", "length", "width", "height", "metadata", "variants.id", "variants.sku"],
        filters: {
            variants: { sku: ["LPV-100-24"] } // Filter path might need adjustment depending on v2
        },
        pagination: { take: 1 }
    });

    // If filter doesn't work deep, grabbing via variant ID approach from previous script
    let product;
    if (products.length > 0) {
        product = products[0];
    } else {
        // Fallback: list variants then get product
        const { data: variants } = await query.graph({
            entity: "product_variant",
            fields: ["id", "product.id"],
            filters: { sku: ["LPV-100-24"] }
        });

        if (variants.length > 0) {
            const prodId = variants[0].product.id;
            const { data: prods } = await query.graph({
                entity: "product",
                fields: ["id", "title", "weight", "length", "width", "height", "metadata"],
                filters: { id: prodId }
            });
            product = prods[0];
        }
    }

    if (!product) {
        console.log("❌ Product not found for SKU LPV-100-24");
        return;
    }

    console.log(`✅ Found Parent Product: ${product.title}`);
    console.log("   Native Fields:");
    console.log(`   - Weight: ${product.weight}`);
    console.log(`   - Length: ${product.length}`);
    console.log(`   - Width: ${product.width}`);
    console.log(`   - Height: ${product.height}`);
    console.log("   Metadata:", product.metadata);
}

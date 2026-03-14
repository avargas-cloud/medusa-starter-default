import { ExecArgs } from "@medusajs/framework/types";

/**
 * Seed script to mark LED Channels products as oversized
 * 
 * Run with: npx medusa exec ./src/scripts/seed-oversized-products.ts
 */
export default async function seedOversizedProducts({ container }: ExecArgs) {
    const query = container.resolve("query");

    console.log("[Seed] Starting oversized products seeding...");

    // Use raw query to fetch products
    const { data: products } = await query.graph({
        entity: "product",
        fields: ["id", "handle", "title", "metadata"],
        pagination: { take: 1000 }
    });

    console.log(`[Seed] Found ${products.length} total products`);

    // Pattern: EAP-*-8S, EAP-*-8W, EAP-*-8B (LED Channels)
    const oversizedPattern = /^eap-.*-8[swb]$/i;

    const matchedProducts = [];

    for (const product of products) {
        const handle = product.handle;

        if (oversizedPattern.test(handle)) {
            matchedProducts.push({
                id: product.id,
                handle: product.handle,
                title: product.title
            });
        }
    }

    console.log(`\n[Seed] ✅ Summary:`);
    console.log(`- Total products: ${products.length}`);
    console.log(`- LED Channels matched: ${matchedProducts.length}`);
    console.log(`\n[Seed] Matched products (pattern: EAP-*-8S/8W/8B):`);
    matchedProducts.forEach(p => console.log(`  - ${p.handle}: ${p.title}`));

    // Update products with oversized metadata
    console.log(`\n[Seed] Updating ${matchedProducts.length} products...`);

    for (const product of matchedProducts) {
        try {
            await query.graph({
                entity: "product",
                fields: ["id"],
                filters: { id: product.id },
                data: {
                    metadata: {
                        shipping_type: "oversized"
                    }
                }
            });
            console.log(`  ✓ Updated: ${product.handle}`);
        } catch (error) {
            console.error(`  ✗ Failed to update ${product.handle}:`, error);
        }
    }

    console.log(`\n[Seed] ✅ Complete!`);

    return {
        matched_count: matchedProducts.length,
        products: matchedProducts
    };
}

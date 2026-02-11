import { ExecArgs } from "@medusajs/framework/types";
import WooCommerceRestApi from "@woocommerce/woocommerce-rest-api";

/**
 * Sync A SINGLE product dimensions from WooCommerce to Medusa
 * Debugging tool for LPV-100-24
 */
export default async function syncSingleProduct({ container }: ExecArgs) {
    const query = container.resolve("query") as any;

    console.log("\n🔄 [Single Dimension Sync] Starting check for LPV-100-24...\n");

    try {
        const WooCommerce = new WooCommerceRestApi({
            url: process.env.WC_URL!,
            consumerKey: process.env.WC_CONSUMER_KEY!,
            consumerSecret: process.env.WC_CONSUMER_SECRET!,
            version: "wc/v3"
        });

        // 1. Fetch from WC
        console.log("📦 Fetching LPV-100-24 from WooCommerce...");
        const response = await WooCommerce.get("products", {
            sku: "LPV-100-24"
        });

        if (response.data.length === 0) {
            console.log("❌ Not found in WC via SKU search!");
            return;
        }

        const wcProduct = response.data[0];
        console.log(`✅ Found WC Product: ${wcProduct.name} (ID: ${wcProduct.id})`);
        console.log(`   Dimensions: ${JSON.stringify(wcProduct.dimensions)}`);
        console.log(`   Weight: ${wcProduct.weight}`);

        const dimensions = {
            height: parseFloat(wcProduct.dimensions?.height) || null,
            width: parseFloat(wcProduct.dimensions?.width) || null,
            length: parseFloat(wcProduct.dimensions?.length) || null,
            weight: parseFloat(wcProduct.weight) || null
        };
        console.log(`   Parsed to update:`, dimensions);

        // 2. Find in Medusa
        console.log("\n🔍 Looking for LPV-100-24 in Medusa...");
        const { data: medusaProducts } = await query.graph({
            entity: "product",
            fields: ["id", "title", "handle", "variants.*"],
            filters: {
                // Try to find ANY product that contains this SKU in its variants
                // Query graph doesn't support deep filtering on variants.sku easily in one go for 'product' entity usually?
                // Standard usage: filtering on product fields.
                // We'll fetch by q (search) or just list all and find? 
                // Let's try filtered by handle if matches slug, or q.
            },
            pagination: { take: 5000 }
        });

        // Manual find since we got all
        const medusaProduct = medusaProducts.find((p: any) =>
            p.variants?.some((v: any) => v.sku === "LPV-100-24")
        );

        if (!medusaProduct) {
            console.log("⚠ No Medusa product found with variant SKU 'LPV-100-24'");

            // Try handle match
            const handleMatch = medusaProducts.find((p: any) => p.handle === wcProduct.slug);
            if (handleMatch) {
                console.log(`   (But found match by handle: ${handleMatch.handle})`);
                console.log("   Variants:", handleMatch.variants.map((v: any) => v.sku));
            } else {
                console.log("   (And no match by handle either)");
            }
            return;
        }

        console.log(`✅ Found Medusa Product: ${medusaProduct.title}`);
        const variant = medusaProduct.variants.find((v: any) => v.sku === "LPV-100-24");

        if (!variant) {
            console.log("❌ Logic error: Product found but variant not found?!");
            return;
        }

        console.log(`   Target Variant ID: ${variant.id}`);
        console.log(`   Target Variant SKU: ${variant.sku}`);

        // 3. Update
        console.log("\n🛠 Attempting Update...");
        await query.graph({
            entity: "product_variant",
            fields: ["id"],
            filters: { id: variant.id },
            data: dimensions
        });
        console.log("✅ Update command sent.");

        // 4. Verify
        console.log("\n🔍 Verifying update...");
        const { data: verifyVar } = await query.graph({
            entity: "product_variant",
            fields: ["id", "weight", "length", "width", "height"],
            filters: { id: variant.id }
        });
        console.log("   Current DB State:", verifyVar[0]);

    } catch (error) {
        console.error("Error:", error);
    }
}

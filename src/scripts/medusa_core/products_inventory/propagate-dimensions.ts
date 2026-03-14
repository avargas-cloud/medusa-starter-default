import { ExecArgs } from "@medusajs/framework/types";
import { Modules } from "@medusajs/framework/utils";

/**
 * Propagate dimensions from Parent Product (Text) to its Variants (Number)
 * 
 * NOTE: ProductVariant native fields in Medusa v2 are Integers.
 * Decimal values like '1.3' will be truncated to '1'.
 * We backup exact values to metadata for safety.
 * 
 * Run with: npx medusa exec ./src/scripts/propagate-dimensions.ts
 */
export default async function propagateDimensions({ container }: ExecArgs) {
    const query = container.resolve("query");
    const productModuleService = container.resolve(Modules.PRODUCT);

    console.log("\n🔄 [Internal Propagation] Starting Parent -> Variant Sync...\n");

    const limit = 1000;
    let offset = 0;
    let hasMore = true;
    let totalUpdated = 0;

    while (hasMore) {
        // Fetch products that have variants
        const { data: products } = await query.graph({
            entity: "product",
            fields: [
                "id", "title",
                "weight", "length", "width", "height",
                "metadata",
                "variants.id", "variants.sku",
                "variants.weight", "variants.length", "variants.width", "variants.height",
                "variants.metadata"
            ],
            pagination: { take: limit, skip: offset }
        });

        if (products.length === 0) {
            hasMore = false;
            break;
        }

        console.log(`Processing batch ${offset} - ${offset + products.length}...`);

        for (const product of products) {
            // Get source dimensions from Parent (String/Text fields)
            const pWeightStr = product.weight || product.metadata?.package_weight_lb;
            const pLengthStr = product.length || product.metadata?.package_length_in;
            const pWidthStr = product.width || product.metadata?.package_width_in;
            const pHeightStr = product.height || product.metadata?.package_height_in;

            const pWeight = parseFloat(pWeightStr) || 0;
            const pLength = parseFloat(pLengthStr) || 0;
            const pWidth = parseFloat(pWidthStr) || 0;
            const pHeight = parseFloat(pHeightStr) || 0;

            if (pWeight === 0 && pLength === 0 && pWidth === 0 && pHeight === 0) {
                continue;
            }

            for (const variant of product.variants) {
                // Determine if we need to update
                // We update if: 
                // 1. Variant native field is 0/null AND Parent has value
                // 2. OR Variant native field is drastically different (e.g. truncated)

                // For now, simple fill logic: If parent has it, valid for child unless child likely has own
                // But for "Variable" products usually they share box size.

                let updatePayload: any = {};
                let metadataUpdate: any = { ...variant.metadata };
                let needsUpdate = false;

                const checkAndSet = (currVal: number, parentVal: number, key: string) => {
                    // Logic: If current is 0, update.
                    // If current is integer of parent (1 vs 1.3), update metadata at least?
                    // We update native if 0.
                    if ((!currVal || currVal === 0) && parentVal > 0) {
                        return true;
                    }
                    return false;
                };

                if (checkAndSet(variant.weight, pWeight, 'weight')) {
                    updatePayload.weight = pWeight; // Native (might truncate)
                    metadataUpdate.shipping_weight = pWeight; // Metadata (exact)
                    needsUpdate = true;
                }

                if (checkAndSet(variant.length, pLength, 'length')) {
                    updatePayload.length = pLength;
                    metadataUpdate.shipping_length = pLength;
                    needsUpdate = true;
                }

                if (checkAndSet(variant.width, pWidth, 'width')) {
                    updatePayload.width = pWidth;
                    metadataUpdate.shipping_width = pWidth;
                    needsUpdate = true;
                }

                if (checkAndSet(variant.height, pHeight, 'height')) {
                    updatePayload.height = pHeight;
                    metadataUpdate.shipping_height = pHeight;
                    needsUpdate = true;
                }

                // Ensure metadata sync even if native matches, for precision
                // But avoid unnecessary DB writes.
                // If native is 1 and parent is 1.3, we SHOULD update metadata.
                const ensureMetadata = (key: string, val: number) => {
                    if (val > 0 && (!variant.metadata?.[key] || variant.metadata?.[key] !== val)) {
                        metadataUpdate[key] = val;
                        needsUpdate = true;
                    }
                };

                ensureMetadata('shipping_weight', pWeight);
                ensureMetadata('shipping_length', pLength);
                ensureMetadata('shipping_width', pWidth);
                ensureMetadata('shipping_height', pHeight);


                if (needsUpdate) {
                    try {
                        updatePayload.metadata = metadataUpdate;
                        await productModuleService.updateProductVariants(variant.id, updatePayload);
                        process.stdout.write(".");
                        totalUpdated++;
                    } catch (e) {
                        // console.error(`Failed ${variant.sku}`);
                    }
                }
            }
        }

        offset += limit;
        if (products.length < limit) hasMore = false;
    }

    console.log(`\n\n✅ Internal Propagation Complete!`);
    console.log(`   Total Variants Updated: ${totalUpdated}`);
}

import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";

/**
 * POST /store/products/batch-prices
 * 
 * Get customer-specific prices for multiple products in a single request.
 * Used by category pages for client-side price updates.
 */
export async function POST(
    req: MedusaRequest,
    res: MedusaResponse
): Promise<void> {
    const { product_ids } = req.body as { product_ids: string[] };

    if (!product_ids || !Array.isArray(product_ids) || product_ids.length === 0) {
        res.status(400).json({
            error: "product_ids array is required"
        });
        return;
    }

    if (product_ids.length > 100) {
        res.status(400).json({
            error: "Maximum 100 products per request"
        });
        return;
    }

    try {
        const query = req.scope.resolve(ContainerRegistrationKeys.QUERY);
        const pricingModule = req.scope.resolve(Modules.PRICING);
        const customerModule = req.scope.resolve(Modules.CUSTOMER);

        // Build pricing context
        const pricingContext: Record<string, any> = {
            currency_code: "usd",
            region_id: "reg_01KFS28SNF1MT1MRHRAFQ6ZGK1" // Default region
        };

        // 💰 SINGLE PRICE MODE GUARD
        // When ENABLE_DYNAMIC_PRICING=false, skip customer group resolution.
        // Everyone gets the same base (retail) price.
        const dynamicPricingEnabled = process.env.ENABLE_DYNAMIC_PRICING !== 'false';

        // Get customer and check for wholesale group
        const customerId = (req as any).auth_context?.actor_id;
        let isWholesale = false;

        if (dynamicPricingEnabled && customerId) {
            try {
                const customer = await customerModule.retrieveCustomer(customerId, {
                    relations: ["groups"]
                });

                if (customer.groups?.length) {
                    pricingContext.customer_group_id = customer.groups.map(g => g.id);
                    isWholesale = customer.groups.some(
                        (g: any) => g.name?.toLowerCase() === 'wholesale'
                    );
                }

                console.log(`[Batch Prices] Customer ${customerId} is ${isWholesale ? 'WHOLESALE' : 'RETAIL'}`);
            } catch (error) {
                console.error('[Batch Prices] Could not fetch customer groups:', error);
            }
        } else if (!dynamicPricingEnabled) {
            console.log(`[Batch Prices] Single Price Mode — using retail prices for all customers.`);
        } else {
            console.log(`[Batch Prices] Guest user - using retail prices`);
        }

        // Fetch products with variants and price_set_id
        const { data: products } = await query.graph({
            entity: "product",
            fields: [
                "id",
                "title",
                "variants.*",
                "variants.price_set.id"
            ],
            filters: {
                id: product_ids
            }
        });

        if (!products || products.length === 0) {
            res.json({ prices: {}, customer_type: isWholesale ? 'wholesale' : 'retail' });
            return;
        }

        console.log(`[Batch Prices] Fetched ${products.length} products`);

        // Get price_set_ids from first variants
        const priceSetData: Array<{ productId: string; priceSetId: string; variantId: string }> = [];

        for (const product of products) {
            if (!product.variants || product.variants.length === 0) continue;

            const firstVariant = product.variants[0];
            if (!firstVariant) continue;

            const priceSetId = (firstVariant as any).price_set?.id;

            if (priceSetId) {
                priceSetData.push({
                    productId: product.id,
                    priceSetId: priceSetId,
                    variantId: firstVariant.id
                });
            }
        }

        if (priceSetData.length === 0) {
            res.json({ prices: {}, customer_type: isWholesale ? 'wholesale' : 'retail' });
            return;
        }

        const priceSetIds = priceSetData.map(p => p.priceSetId);

        console.log(`[Batch Prices] Calculating prices for ${priceSetIds.length} price sets with context:`, pricingContext);

        // Calculate prices using correct Medusa v2 API
        const calculatedPrices = await pricingModule.calculatePrices(
            { id: priceSetIds },
            { context: pricingContext } // IMPORTANT: context wrapped in object
        );

        console.log(`[Batch Prices] ✅ Calculated ${calculatedPrices.length} prices`);

        // Map prices back to products
        const prices: Record<string, any> = {};

        for (const data of priceSetData) {
            const calculatedPrice = calculatedPrices.find((p: any) => p.id === data.priceSetId);

            if (!calculatedPrice) {
                console.warn(`[Batch Prices] No price found for price_set ${data.priceSetId}`);
                continue;
            }

            prices[data.productId] = {
                amount: calculatedPrice.calculated_amount || 0,
                currency_code: calculatedPrice.currency_code || 'usd',
                price_list_type: isWholesale ? 'wholesale' : 'retail',
                variant_id: data.variantId
            };
        }

        console.log(`[Batch Prices] Returning prices for ${Object.keys(prices).length} products`);

        res.json({
            prices,
            customer_type: isWholesale ? 'wholesale' : 'retail'
        });

    } catch (error) {
        console.error("[Batch Prices] Error:", error);
        res.status(500).json({
            error: "Failed to fetch batch prices",
            details: error instanceof Error ? error.message : String(error)
        });
    }
}

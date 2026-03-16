import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { ContainerRegistrationKeys, Modules } from "@medusajs/utils";

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

        // Fetch active store config to pass down global prefixes
        let activeStoreConfig = ["LEG"];
        try {
            const { data: stores } = await query.graph({
                entity: "store",
                fields: ["metadata"]
            });
            if (stores && stores.length > 0 && Array.isArray(stores[0]!.metadata?.non_wholesale_prefixes)) {
                activeStoreConfig = stores[0]!.metadata!.non_wholesale_prefixes as string[];
            }
        } catch (err: any) {
            console.error("[Batch Prices] ⚠️ Error fetching store metadata:", err.message);
        }

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

                // console.log(`[Batch Prices] Customer ${customerId} is ${isWholesale ? 'WHOLESALE' : 'RETAIL'}`);
            } catch (error) {
                console.error('[Batch Prices] Could not fetch customer groups:', error);
            }
        } else if (!dynamicPricingEnabled) {
            // console.log(`[Batch Prices] Single Price Mode — using retail prices for all customers.`);
        } else {
            // console.log(`[Batch Prices] Guest user - using retail prices`);
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
            res.json({ 
                prices: {}, 
                customer_type: isWholesale ? 'wholesale' : 'retail',
                store_config: { non_wholesale_prefixes: activeStoreConfig }
            });
            return;
        }

        // console.log(`[Batch Prices] Fetched ${products.length} products`);

        // Get price_set_ids from first variants
        const priceSetData: Array<{ productId: string; priceSetId: string; variantId: string; sku: string }> = [];

        for (const product of products) {
            if (!product.variants || product.variants.length === 0) continue;

            for (const variant of product.variants) {
                const priceSetId = (variant as any).price_set?.id;
                const sku = (variant as any).sku || "";

                if (priceSetId) {
                    priceSetData.push({
                        productId: product.id,
                        priceSetId: priceSetId,
                        variantId: variant.id,
                        sku: sku
                    });
                }
            }
        }



        if (priceSetData.length === 0) {
            res.json({ 
                prices: {}, 
                customer_type: isWholesale ? 'wholesale' : 'retail',
                store_config: { non_wholesale_prefixes: activeStoreConfig }
            });
            return;
        }

        const priceSetIds = priceSetData.map(p => p.priceSetId);

        // console.log(`[Batch Prices] Calculating prices for ${priceSetIds.length} price sets with context:`, pricingContext);

        // Calculate prices using correct Medusa v2 API
        const calculatedPrices = await pricingModule.calculatePrices(
            { id: priceSetIds },
            { context: pricingContext } // IMPORTANT: context wrapped in object
        );

        console.log(`[Batch Prices] ✅ First calculatedPrice:`, JSON.stringify(calculatedPrices[0], null, 2));

        // Map prices back to products
        const prices: Record<string, any> = {};

        for (const data of priceSetData) {
            const calculatedPrice = calculatedPrices.find((p: any) => p.id === data.priceSetId);

            if (!calculatedPrice) {
                console.warn(`[Batch Prices] No price found for price_set ${data.priceSetId}`);
                continue;
            }

            const amt = calculatedPrice.calculated_amount || 0;

            if (!prices[data.productId]) {
                prices[data.productId] = {
                    amount: amt,
                    amount_max: amt,
                    currency_code: calculatedPrice.currency_code || 'usd',
                    price_list_type: isWholesale ? 'wholesale' : 'retail',
                    variant_id: data.variantId,
                    sku: data.sku
                };
            } else {
                if (amt < prices[data.productId].amount) {
                    prices[data.productId].amount = amt;
                    prices[data.productId].variant_id = data.variantId;
                    prices[data.productId].sku = data.sku;
                }
                if (amt > prices[data.productId].amount_max) {
                    prices[data.productId].amount_max = amt;
                }
            }
        }

        // console.log(`[Batch Prices] Returning prices for ${Object.keys(prices).length} products`);

        res.json({
            prices,
            customer_type: isWholesale ? 'wholesale' : 'retail',
            store_config: { non_wholesale_prefixes: activeStoreConfig }
        });

    } catch (error) {
        console.error("[Batch Prices] Error:", error);
        res.status(500).json({
            error: "Failed to fetch batch prices",
            details: error instanceof Error ? error.message : String(error)
        });
    }
}

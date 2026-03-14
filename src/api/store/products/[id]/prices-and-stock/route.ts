import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"

// Cache manager removed - using fresh pricing calculations

/**
 * GET /store/products/:id/prices-and-stock
 * 
 * ✅ CORRECT IMPLEMENTATION using Medusa v2 native pricing
 * - Uses pricingModule.calculatePrices() correctly
 * - Supports customer-specific pricing (wholesale/retail)
 * - Fetches inventory via SQL
 * 
 * @route GET /store/products/:id/prices-and-stock
 */
export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
    try {
        const { id } = req.params

        // Build pricing context
        const pricingContext: Record<string, any> = {
            currency_code: "usd",
            region_id: "reg_01KFS28SNF1MT1MRHRAFQ6ZGK1"
        }

        // 💰 SINGLE PRICE MODE GUARD
        // When ENABLE_DYNAMIC_PRICING=false, everyone gets the same base (retail) price.
        // Skip customer group resolution so no wholesale price list is ever matched.
        const dynamicPricingEnabled = process.env.ENABLE_DYNAMIC_PRICING !== 'false';

        // Get customer groups for wholesale pricing (only in Dynamic Pricing mode)
        const customerId = (req as any).auth_context?.actor_id

        let isWholesaleCustomer = false;

        if (dynamicPricingEnabled && customerId) {
            try {
                const customerModule = req.scope.resolve("customer")
                const customer = await customerModule.retrieveCustomer(customerId, {
                    relations: ["groups"]
                })

                if (customer.groups?.length) {
                    pricingContext.customer_group_id = customer.groups.map((g: any) => g.id)
                    isWholesaleCustomer = customer.groups.some((g: any) => 
                        g.name?.toLowerCase().includes('wholesale') || 
                        g.name?.toLowerCase().includes('distributor')
                    );
                }
            } catch (error) {
                // Could not fetch customer groups
            }
        }

        // Cache removed - prices calculated fresh every time for dynamic pricing

        const knex = req.scope.resolve("__pg_connection__")
        const query = req.scope.resolve("query")
        const pricingModule = req.scope.resolve("pricing")

        // Fetch active store config to pass down global prefixes
        let activeStoreConfig = ["LEG"];
        try {
            const { data: stores } = await query.graph({
                entity: "store",
                fields: ["metadata"]
            });
            if (stores && stores.length > 0 && (stores[0] as any).metadata?.non_wholesale_prefixes) {
                activeStoreConfig = (stores[0] as any).metadata.non_wholesale_prefixes as string[];
            }
        } catch (err: any) {
            console.error("[PRICES-STOCK] ⚠️ Error fetching store metadata:", err.message);
        }

        // Step 1: Get variants with price_set_id
        const { data: variants } = await query.graph({
            entity: "variant",
            fields: [
                "id",
                "title",
                "sku",
                "price_set.id"
            ],
            filters: { product_id: id }
        })


        if (variants.length === 0) {
            return res.json({
                product_id: id,
                variants: [],
                timestamp: new Date().toISOString()
            })
        }

        // Step 2: Calculate prices using Pricing Module (CORRECT WAY)
        const priceSetIds = variants
            .map((v: any) => v.price_set?.id)
            .filter((id: any): id is string => Boolean(id))


        let calculatedPrices: any[] = []
        if (priceSetIds.length > 0) {
            try {
                calculatedPrices = await pricingModule.calculatePrices(
                    { id: priceSetIds },
                    { context: pricingContext }
                )
                console.log(`[PRICES-STOCK] ✅ Calculated ${calculatedPrices.length} prices`)
                if (calculatedPrices.length > 0) {
                    console.log(`[PRICES-STOCK] 🔍 Sample price:`, {
                        id: calculatedPrices[0].id,
                        amount: calculatedPrices[0].calculated_amount,
                        currency: calculatedPrices[0].currency_code
                    })
                }
            } catch (error: any) {
                console.error(`[PRICES-STOCK] ❌ Price calculation error:`, error.message)
            }
        }

        // Step 3: Fetch inventory
        const inventory = await knex("inventory_level")
            .select(
                "inventory_level.stocked_quantity",
                "inventory_level.incoming_quantity",
                "inventory_level.reserved_quantity",
                "product_variant_inventory_item.variant_id"
            )
            .join("product_variant_inventory_item", "inventory_level.inventory_item_id", "product_variant_inventory_item.inventory_item_id")
            .join("product_variant", "product_variant_inventory_item.variant_id", "product_variant.id")
            .where("product_variant.product_id", id)
            .whereNull("inventory_level.deleted_at")
            .whereNull("product_variant.deleted_at")

        // Step 4: Map everything together
        const variantData = variants.map((v: any) => {
            const priceSetId = v.price_set?.id
            const calculatedPrice = calculatedPrices.find((p: any) => p.id === priceSetId)

            const inv = inventory.find(i => i.variant_id === v.id)
            const availableQuantity = inv
                ? (inv.stocked_quantity || 0) - (inv.reserved_quantity || 0)
                : 0

            return {
                variant_id: v.id,
                sku: v.sku,
                title: v.title,
                price: {
                    amount: calculatedPrice?.calculated_amount || 0,
                    original_amount: calculatedPrice?.original_amount,
                    currency_code: calculatedPrice?.currency_code || 'usd',
                    formatted: `$${(calculatedPrice?.calculated_amount || 0).toFixed(2)}`
                },
                inventory: {
                    available: availableQuantity,
                    stocked: inv?.stocked_quantity || 0,
                    incoming: inv?.incoming_quantity || 0,
                    reserved: inv?.reserved_quantity || 0,
                    in_stock: availableQuantity > 0
                }
            }
        })

        const responseData = {
            product_id: id,
            variants: variantData,
            customer_context: {
                customer_id: customerId || 'anonymous',
                customer_groups: pricingContext.customer_group_id || [],
                is_wholesale: isWholesaleCustomer
            },
            store_config: {
                non_wholesale_prefixes: activeStoreConfig
            },
            timestamp: new Date().toISOString()
        }

        // No caching - prices are calculated fresh every time
        // This ensures dynamic pricing always reflects current prices

        // Prevent HTTP browser cache - always get fresh prices
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private')
        res.setHeader('Pragma', 'no-cache')
        res.setHeader('Expires', '0')

        return res.json(responseData)

    } catch (error: any) {
        console.error("[PRICES-STOCK] ❌ Error:", error.message)
        console.error("[PRICES-STOCK] Stack:", error.stack)
        return res.status(500).json({
            error: "Failed to fetch prices and stock",
            message: error.message
        })
    }
}

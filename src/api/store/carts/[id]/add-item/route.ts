import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { addToCartWorkflow } from "@medusajs/core-flows"

/**
 * POST /store/carts/:id/add-item
 * 
 * Custom cart add endpoint with wholesale pricing support.
 * 
 * The standard Medusa /line-items endpoint doesn't apply customer group pricing
 * from price lists when adding items. This endpoint:
 * 1. Resolves the authenticated customer's group (e.g., Wholesale)
 * 2. Calculates the correct price using the Pricing Module
 * 3. Adds the item using Medusa's workflow
 * 4. If a lower price was found via wholesale price list, updates the line item price
 */
export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
    try {
        const cartId = req.params.id as string
        const body = req.body as { variant_id: string; quantity: number; metadata?: Record<string, any> }

        if (!body.variant_id || !body.quantity) {
            return res.status(400).json({ message: "variant_id and quantity are required" })
        }

        console.log(`[ADD-ITEM] 🛒 Adding variant ${body.variant_id} x${body.quantity} to cart ${cartId}`)

        // Step 1: Find customer's groups for wholesale pricing
        const pricingContext: Record<string, any> = {
            currency_code: "usd",
            region_id: "reg_01KFS28SNF1MT1MRHRAFQ6ZGK1"
        }

        const customerId = (req as any).auth_context?.actor_id
        let wholesalePrice: number | null = null

        if (customerId) {
            try {
                const customerModule = req.scope.resolve(Modules.CUSTOMER)
                const customer = await customerModule.retrieveCustomer(customerId, {
                    relations: ["groups"]
                })

                if (customer.groups?.length) {
                    pricingContext.customer_group_id = customer.groups.map((g: any) => g.id)
                    console.log(`[ADD-ITEM] 👑 Customer groups:`, pricingContext.customer_group_id)

                    // Step 2: Calculate the correct price using the Pricing Module
                    const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)
                    const pricingModule = req.scope.resolve(Modules.PRICING)

                    // Get price_set_id for this variant
                    const { data: variants } = await query.graph({
                        entity: "variant",
                        fields: ["id", "price_set.id"],
                        filters: { id: body.variant_id }
                    })

                    const priceSetId = variants?.[0]?.price_set?.id
                    if (priceSetId) {
                        const calculatedPrices = await pricingModule.calculatePrices(
                            { id: [priceSetId] },
                            { context: pricingContext }
                        )

                        const firstPrice = calculatedPrices[0]
                        if (firstPrice && firstPrice.calculated_amount !== null && firstPrice.calculated_amount !== undefined) {
                            const calculatedAmount = firstPrice.calculated_amount
                            console.log(`[ADD-ITEM] 💰 Calculated price: $${calculatedAmount}`)
                            wholesalePrice = parseFloat(String(calculatedAmount))
                        }
                    }
                }
            } catch (error: any) {
                console.warn(`[ADD-ITEM] ⚠️ Could not calculate wholesale price:`, error.message)
            }
        }

        // Step 3: Add the item using Medusa's standard workflow
        const { result } = await addToCartWorkflow(req.scope).run({
            input: {
                cart_id: cartId,
                items: [{
                    variant_id: body.variant_id,
                    quantity: body.quantity,
                    metadata: body.metadata
                }]
            }
        })

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let cart: any = result

        // Step 4: If we have a wholesale price, update the line item price
        if (wholesalePrice !== null) {
            try {
                // Find the newly added line item (the one with our variant_id)
                const newItem = (cart as any)?.items?.find((item: any) => item.variant_id === body.variant_id)

                if (newItem && newItem.unit_price !== wholesalePrice) {
                    console.log(`[ADD-ITEM] 🔄 Overriding price from $${newItem.unit_price} to $${wholesalePrice} (wholesale)`)

                    const cartModule = req.scope.resolve(Modules.CART)
                    await cartModule.updateLineItems(newItem.id, {
                        unit_price: wholesalePrice
                    })

                    // Refresh the cart to get the updated prices
                    const refreshedCart = await cartModule.retrieveCart(cartId, {
                        relations: ["items", "items.variant", "items.variant.product"]
                    })
                    cart = refreshedCart as any
                }
            } catch (priceUpdateErr: any) {
                console.warn(`[ADD-ITEM] ⚠️ Could not update line item price:`, priceUpdateErr.message)
                // Return cart even if price update fails
            }
        }

        return res.json({ cart })

    } catch (error: any) {
        console.error("[ADD-ITEM] ❌ Error:", error.message)
        return res.status(500).json({
            error: "Failed to add item to cart",
            message: error.message
        })
    }
}

import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"

/**
 * POST /store/carts/:id/reprice
 *
 * Reprices ALL cart items to a customer's context (retail or wholesale) in a SINGLE request.
 *
 * 🧠 WHY THIS EXISTS:
 * Medusa doesn't auto-reprice existing line items when a customer is associated with a cart.
 * The normal flow would be to call updateLineItemInCartWorkflow for each item individually,
 * which takes ~2.3s per item (1 HTTP round-trip + full workflow per item).
 *
 * This endpoint:
 * 1. Resolves the customer's group (once — not N times)
 * 2. Batch calculates the correct price for ALL variants using the Pricing Module
 * 3. Updates ALL line item prices directly via cartModule.updateLineItems (skips workflow overhead)
 * 4. Returns the refreshed cart
 *
 * Result: O(1) HTTP calls instead of O(N), ~0.5-2s total instead of N × 2.3s.
 */
export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
    try {
        const cartId = req.params.id as string
        const dynamicPricingEnabled = process.env.ENABLE_DYNAMIC_PRICING !== 'false'

        console.log(`[REPRICE] 🔄 Repricing cart ${cartId} | dynamic=${dynamicPricingEnabled}`)

        // --- Resolve modules ---
        const cartModule = req.scope.resolve(Modules.CART)
        const pricingModule = req.scope.resolve(Modules.PRICING)
        const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)

        // --- Fetch current cart with line items ---
        const cart = await cartModule.retrieveCart(cartId, {
            relations: ["items"]
        }) as any

        if (!cart?.items?.length) {
            console.log(`[REPRICE] Cart ${cartId} has no items — nothing to reprice.`)
            return res.json({ cart })
        }

        // --- Resolve pricing context ---
        const pricingContext: Record<string, any> = {
            currency_code: cart.currency_code || "usd",
            region_id: cart.region_id || "reg_01KFS28SNF1MT1MRHRAFQ6ZGK1"
        }

        // Resolve customer group (once) if dynamic pricing is enabled
        const customerId = (req as any).auth_context?.actor_id
        let isWholesale = false

        if (dynamicPricingEnabled && customerId) {
            try {
                const customerModule = req.scope.resolve(Modules.CUSTOMER)
                const customer = await customerModule.retrieveCustomer(customerId, {
                    relations: ["groups"]
                })
                if (customer.groups?.length) {
                    pricingContext.customer_group_id = customer.groups.map((g: any) => g.id)
                    isWholesale = true
                    console.log(`[REPRICE] 👑 Wholesale customer — groups:`, pricingContext.customer_group_id)
                } else {
                    console.log(`[REPRICE] Retail customer — no wholesale groups`)
                }
            } catch (err: any) {
                console.warn(`[REPRICE] Could not resolve customer groups:`, err.message)
            }
        }

        // --- Collect all unique variant IDs from cart items ---
        const variantIds = [...new Set(cart.items.map((item: any) => item.variant_id).filter(Boolean))] as string[]

        console.log(`[REPRICE] Fetching price sets for ${variantIds.length} variants...`)

        // --- Batch fetch price_set_id for all variants in one query ---
        const { data: variants } = await query.graph({
            entity: "variant",
            fields: ["id", "price_set.id"],
            filters: { id: variantIds }
        })

        // Build map: variantId → priceSetId
        const variantToPriceSet: Record<string, string> = {}
        for (const v of variants || []) {
            if (v.price_set?.id) {
                variantToPriceSet[v.id] = v.price_set.id
            }
        }

        const priceSetIds = Object.values(variantToPriceSet)
        if (!priceSetIds.length) {
            console.warn(`[REPRICE] No price sets found for variants — skipping price update.`)
            return res.json({ cart })
        }

        // --- Batch calculate prices for ALL price sets at once ---
        console.log(`[REPRICE] Calculating prices for ${priceSetIds.length} price sets...`)
        const calculatedPrices = await pricingModule.calculatePrices(
            { id: priceSetIds },
            { context: pricingContext }
        )

        // Build map: priceSetId → calculated_amount
        const priceSetToAmount: Record<string, number> = {}
        for (const p of calculatedPrices || []) {
            if (p.id && p.calculated_amount !== null && p.calculated_amount !== undefined) {
                priceSetToAmount[p.id] = parseFloat(String(p.calculated_amount))
            }
        }

        // --- Update each line item price if it changed ---
        const updatePromises: Promise<any>[] = []
        let updatesQueued = 0

        for (const item of cart.items) {
            const priceSetId = variantToPriceSet[item.variant_id]
            if (!priceSetId) continue

            const newPrice = priceSetToAmount[priceSetId]
            if (newPrice === undefined) continue

            if (item.unit_price !== newPrice) {
                console.log(`[REPRICE] Item ${item.id}: $${item.unit_price} → $${newPrice} (${isWholesale ? 'wholesale' : 'retail'})`)
                updatePromises.push(
                    cartModule.updateLineItems(item.id, { unit_price: newPrice })
                )
                updatesQueued++
            } else {
                console.log(`[REPRICE] Item ${item.id}: price unchanged at $${item.unit_price}`)
            }
        }

        if (updatePromises.length) {
            // Fire all price updates in parallel — cartModule.updateLineItems is a direct DB call,
            // not a workflow, so no Redis lock serialization. This is safe.
            await Promise.all(updatePromises)
            console.log(`[REPRICE] ✅ Updated ${updatesQueued} line item prices in parallel.`)
        } else {
            console.log(`[REPRICE] ℹ️ No price changes needed.`)
        }

        // Return success — the frontend will call GET /store/carts/:id to get the properly
        // formatted cart with calculated totals. We don't attempt retrieveCart here because
        // cartModule.retrieveCart uses a different schema than the HTTP API.
        console.log(`[REPRICE] ✅ Done. ${updatesQueued} price(s) updated.`)
        return res.json({ success: true, updatesApplied: updatesQueued })

    } catch (error: any) {
        console.error("[REPRICE] ❌ Error:", error.message, error.stack)
        return res.status(500).json({
            error: "Failed to reprice cart",
            message: error.message
        })
    }
}

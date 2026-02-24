import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { Pool } from "pg"

/**
 * POST /store/carts/:id/reprice
 *
 * Reprices ALL items in a cart to match the current customer's pricing context.
 *
 * CALLED IN TWO SCENARIOS:
 *   1. LOGIN  (with auth token):  customer group resolved → wholesale prices
 *   2. LOGOUT (no auth token):    no customer group → retail base prices
 *
 * WHY NOT updateLineItemInCartWorkflow IN PARALLEL:
 *   Medusa's workflow engine acquires a per-cart Redis lock for each workflow run.
 *   Running multiple workflows for the same cart in parallel causes all but one to
 *   fail with "Failed to acquire lock". There is no parallelism-safe native workflow.
 *
 * APPROACH:
 *   1. Batch-fetch prices from Pricing Module (no locks, 1 fast DB call)
 *   2. Update all line items via cartModule.updateLineItems (fast direct DB, no locks)
 *   3. Immediately patch is_custom_price = false on those items via raw SQL
 *      (cartModule.updateLineItems sets is_custom_price=true, which breaks Admin totals)
 *
 * This gives us: O(1) latency, no lock contention, correct prices, correct is_custom_price.
 */
export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
    try {
        const cartId = req.params.id as string

        console.log(`[REPRICE] 🔄 Repricing cart ${cartId}`)

        const cartModule = req.scope.resolve(Modules.CART)
        const pricingModule = req.scope.resolve(Modules.PRICING)
        const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)

        const cart = await cartModule.retrieveCart(cartId, { relations: ["items"] }) as any

        if (!cart?.items?.length) {
            console.log(`[REPRICE] No items — skipping.`)
            return res.json({ success: true, updatesApplied: 0 })
        }

        // --- Resolve pricing context ---
        const pricingContext: Record<string, any> = {
            currency_code: cart.currency_code || "usd",
            region_id: cart.region_id
        }

        const customerId = (req as any).auth_context?.actor_id
        let isWholesale = false

        if (customerId) {
            try {
                const customerModule = req.scope.resolve(Modules.CUSTOMER)
                const customer = await customerModule.retrieveCustomer(customerId, { relations: ["groups"] })
                if (customer.groups?.length) {
                    pricingContext.customer_group_id = customer.groups.map((g: any) => g.id)
                    isWholesale = true
                    console.log(`[REPRICE] 👑 Wholesale — groups:`, pricingContext.customer_group_id)
                }
            } catch (err: any) {
                console.warn(`[REPRICE] Could not resolve customer groups:`, err.message)
            }
        } else {
            console.log(`[REPRICE] No auth — repricing to retail`)
        }

        // --- Batch fetch price sets ---
        const variantIds = [...new Set(cart.items.map((i: any) => i.variant_id).filter(Boolean))] as string[]
        const { data: variants } = await query.graph({
            entity: "variant",
            fields: ["id", "price_set.id"],
            filters: { id: variantIds }
        })

        const variantToPriceSet: Record<string, string> = {}
        for (const v of variants || []) {
            if (v.price_set?.id) variantToPriceSet[v.id] = v.price_set.id
        }

        const priceSetIds = Object.values(variantToPriceSet)
        if (!priceSetIds.length) {
            return res.json({ success: true, updatesApplied: 0 })
        }

        // --- Batch calculate prices ---
        const calculatedPrices = await pricingModule.calculatePrices(
            { id: priceSetIds },
            { context: pricingContext }
        )

        const priceSetToAmount: Record<string, number> = {}
        for (const p of calculatedPrices || []) {
            if (p.id && p.calculated_amount !== null && p.calculated_amount !== undefined) {
                priceSetToAmount[p.id] = parseFloat(String(p.calculated_amount))
            }
        }

        // --- Update changed items ---
        const updatesNeeded: { itemId: string; newPrice: number }[] = []
        for (const item of cart.items) {
            const priceSetId = variantToPriceSet[item.variant_id]
            if (!priceSetId) continue
            const newPrice = priceSetToAmount[priceSetId]
            if (newPrice === undefined) continue
            if (item.unit_price !== newPrice) {
                console.log(`[REPRICE] ${item.id}: $${item.unit_price} → $${newPrice} (${isWholesale ? 'wholesale' : 'retail'})`)
                updatesNeeded.push({ itemId: item.id, newPrice })
            }
        }

        if (!updatesNeeded.length) {
            console.log(`[REPRICE] No price changes needed.`)
            return res.json({ success: true, updatesApplied: 0 })
        }

        // Step 1: Update prices (this sets is_custom_price=true — we'll fix that next)
        await Promise.all(
            updatesNeeded.map(({ itemId, newPrice }) =>
                cartModule.updateLineItems(itemId, { unit_price: newPrice })
            )
        )

        // Step 2: Reset is_custom_price=false so Admin totals are correct.
        // cartModule.updateLineItems always sets is_custom_price=true when unit_price is passed.
        // We patch it immediately to false since these prices come from Medusa's own Pricing Module,
        // not from manual user input.
        try {
            const pool = new Pool({
                connectionString: process.env.DATABASE_URL,
                ssl: process.env.DATABASE_URL?.includes('railway') ? { rejectUnauthorized: false } : false
            })
            const itemIds = updatesNeeded.map(u => u.itemId)
            await pool.query(
                `UPDATE cart_line_item SET is_custom_price = false WHERE id = ANY($1)`,
                [itemIds]
            )
            await pool.end()
            console.log(`[REPRICE] ✅ Reset is_custom_price=false on ${itemIds.length} item(s).`)
        } catch (patchErr: any) {
            // Non-fatal: prices are correct, is_custom_price flag not patched
            console.warn(`[REPRICE] ⚠️ Could not reset is_custom_price:`, patchErr.message)
        }

        console.log(`[REPRICE] ✅ Done. ${updatesNeeded.length} price(s) updated.`)
        return res.json({ success: true, updatesApplied: updatesNeeded.length })

    } catch (error: any) {
        console.error("[REPRICE] ❌ Error:", error.message, error.stack)
        return res.status(500).json({
            error: "Failed to reprice cart",
            message: error.message
        })
    }
}

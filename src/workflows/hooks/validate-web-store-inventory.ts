import { completeCartWorkflow } from "@medusajs/medusa/core-flows"
import { MedusaError } from "@medusajs/utils"
import { StepResponse } from "@medusajs/framework/workflows-sdk"

// Workaround for Medusa's exported types missing the internal hooks:
const hooks = completeCartWorkflow.hooks as any

/**
 * Hook: validate-web-store-inventory
 *
 * Purpose:
 *   Blocks checkout on the Web Store (ecopowertech.com) when any item
 *   in the cart exceeds available inventory.
 *
 *   The POS channel (pos.ecopowertech.com) is EXEMPT — it can always
 *   proceed with backorder, since store reps can order from suppliers.
 *
 * Sales Channels:
 *   Web Store: sc_01KFH7QCHT364SX242A69ZR435  (Default Sales Channel)
 *   POS:       sc_15154EAF0D194265ADD21AAD2D
 *
 * Env Vars used:
 *   WEB_STORE_SALES_CHANNEL_ID  (fallback to hardcoded default)
 *   POS_SALES_CHANNEL_ID
 */

const WEB_STORE_CHANNEL_ID =
    process.env.WEB_STORE_SALES_CHANNEL_ID ?? "sc_01KFH7QCHT364SX242A69ZR435"

hooks.validate(
    async (
        { cart_id }: { cart_id: string },
        { container }: { container: any }
    ) => {
        const query = container.resolve("query")

        // 1. Fetch cart with sales_channel, items, and variant inventory
        const { data: carts } = await query.graph({
            entity: "cart",
            fields: [
                "id",
                "sales_channel_id",
                "items.*",
                "items.variant.*",
                "items.variant.inventory_items.*",
                "items.variant.inventory_items.inventory.*",
            ],
            filters: { id: cart_id },
        })

        if (!carts.length) {
            console.log(`[inventory-guard] Cart ${cart_id} not found — skipping`)
            return new StepResponse(null)
        }

        const cart = carts[0]

        // 2. Only enforce on Web Store channel
        if (cart.sales_channel_id !== WEB_STORE_CHANNEL_ID) {
            console.log(
                `[inventory-guard] Channel ${cart.sales_channel_id} is POS — backorder ALLOWED, skipping check`
            )
            return new StepResponse(null)
        }

        console.log(
            `[inventory-guard] Web Store cart ${cart_id} — running inventory check`
        )

        const outOfStockItems: string[] = []

        for (const item of cart.items ?? []) {
            const variantTitle = item.variant?.title ?? item.title ?? "Unknown product"
            const requestedQty = item.quantity ?? 0

            // Sum stocked quantity across all inventory items for this variant
            let availableQty = 0
            for (const inventoryItem of item.variant?.inventory_items ?? []) {
                const stocked = inventoryItem.inventory?.stocked_quantity ?? 0
                const reserved = inventoryItem.inventory?.reserved_quantity ?? 0
                availableQty += Math.max(0, stocked - reserved)
            }

            console.log(
                `[inventory-guard]   "${variantTitle}" → requested: ${requestedQty}, available: ${availableQty}`
            )

            if (requestedQty > availableQty) {
                outOfStockItems.push(
                    `"${variantTitle}" (requested ${requestedQty}, only ${availableQty} available)`
                )
            }
        }

        if (outOfStockItems.length > 0) {
            console.log(
                `[inventory-guard] ❌ Blocking checkout — OOS items: ${outOfStockItems.join(", ")}`
            )
            throw new MedusaError(
                MedusaError.Types.NOT_ALLOWED,
                `The following items are out of stock: ${outOfStockItems.join("; ")}. Please remove them from your cart to continue.`
            )
        }

        console.log(`[inventory-guard] ✅ All items in stock — checkout allowed`)
        return new StepResponse(null)
    }
)

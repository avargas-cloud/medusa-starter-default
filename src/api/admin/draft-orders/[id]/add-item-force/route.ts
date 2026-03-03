import type { MedusaRequest, MedusaResponse } from "@medusajs/framework"
import { Modules } from "@medusajs/utils"

/**
 * POST /admin/draft-orders/:id/add-item-force
 *
 * Adds a line item to a draft order WITHOUT inventory checks.
 * Calls orderModule.createOrderLineItems() directly — pure data layer,
 * bypasses all workflow validation including inventory.
 *
 * Body: { variant_id, quantity?, unit_price? }
 *
 * NOTE: unit_price should be in DOLLARS (decimal), matching Medusa API convention.
 *       This route converts to cents for the orderModule internally.
 */
export async function POST(
    req: MedusaRequest,
    res: MedusaResponse
): Promise<void> {
    const { id } = req.params as { id: string }
    const { variant_id, quantity = 1, unit_price } = req.body as {
        variant_id: string
        quantity?: number
        unit_price?: number  // in DOLLARS (e.g. 29.99)
    }

    if (!variant_id) {
        res.status(400).json({ message: "variant_id is required" })
        return
    }

    try {
        const orderModule = req.scope.resolve(Modules.ORDER) as any
        const productModule = req.scope.resolve(Modules.PRODUCT) as any

        // Resolve variant info for title and default price
        let title = variant_id
        let variantTitle: string | undefined
        let thumbnail: string | undefined
        let resolvedPriceCents = 0

        try {
            const [variant] = await productModule.listProductVariants(
                { id: [variant_id] },
                { relations: ["prices", "product"] }
            ) as any[]
            const vAny = variant as any
            title = vAny?.product?.title ?? vAny?.title ?? variant_id
            variantTitle = vAny?.title !== title ? vAny?.title : undefined
            thumbnail = vAny?.product?.thumbnail ?? undefined

            if (unit_price !== undefined) {
                // Caller sends dollars → convert to cents for orderModule
                resolvedPriceCents = Math.round(unit_price * 100)
            } else if ((vAny?.prices?.length ?? 0) > 0) {
                // Prices in DB are already in cents
                resolvedPriceCents = vAny.prices[0].amount
            }
        } catch {
            // best-effort: proceed with defaults
            if (unit_price !== undefined) resolvedPriceCents = Math.round(unit_price * 100)
        }

        // createOrderLineItems is the correct module-level API (no workflow, no inventory check)
        // Accepts unit_price in cents
        await orderModule.createOrderLineItems(id, [{
            variant_id,
            quantity,
            unit_price: resolvedPriceCents,
            title,
            variant_title: variantTitle,
            thumbnail,
            is_discountable: true,
            requires_shipping: true,
        }])

        res.status(200).json({ success: true })
    } catch (e: any) {
        console.error("[add-item-force]", e?.message)
        res.status(500).json({ message: e?.message ?? "Failed to add item" })
    }
}

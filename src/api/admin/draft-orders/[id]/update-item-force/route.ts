import type { MedusaRequest, MedusaResponse } from "@medusajs/framework"
import { Modules } from "@medusajs/utils"

/**
 * POST /admin/draft-orders/:id/update-item-force
 *
 * Updates quantity and/or unit_price of an existing line item in a draft order
 * WITHOUT going through the order-edit workflow (which silently fails for draft orders).
 *
 * Uses orderModule.updateOrderLineItems() directly — pure data layer,
 * bypasses workflow validation including inventory checks.
 *
 * Body: { line_item_id: string, quantity?: number, unit_price?: number }
 *
 * NOTE: unit_price should be in DOLLARS (decimal), matching Medusa v2 API convention.
 */
export async function POST(
    req: MedusaRequest,
    res: MedusaResponse
): Promise<void> {
    const { line_item_id, quantity, unit_price } = req.body as {
        line_item_id: string
        quantity?: number
        unit_price?: number  // in DOLLARS (e.g. 56.75)
    }

    if (!line_item_id) {
        res.status(400).json({ message: "line_item_id is required" })
        return
    }

    if (quantity === undefined && unit_price === undefined) {
        res.status(400).json({ message: "At least one of quantity or unit_price is required" })
        return
    }

    try {
        const orderModule = req.scope.resolve(Modules.ORDER) as any

        const updateData: Record<string, any> = {}
        if (quantity !== undefined) updateData.quantity = quantity
        if (unit_price !== undefined) updateData.unit_price = unit_price

        if (typeof orderModule.updateOrderLineItems === "function") {
            await orderModule.updateOrderLineItems(line_item_id, updateData)
            console.log(`[update-item-force] updateOrderLineItems OK: ${line_item_id} → qty=${quantity} price=${unit_price}`)
            res.status(200).json({ success: true, method: "updateOrderLineItems" })
            return
        }

        if (typeof orderModule.updateLineItems === "function") {
            await orderModule.updateLineItems([{ id: line_item_id, ...updateData }])
            console.log(`[update-item-force] updateLineItems OK: ${line_item_id}`)
            res.status(200).json({ success: true, method: "updateLineItems" })
            return
        }

        res.status(500).json({ message: "No suitable update method found on order module" })
    } catch (e: any) {
        console.error("[update-item-force] Error:", e?.message)
        res.status(500).json({ message: e?.message ?? "Failed to update item" })
    }
}

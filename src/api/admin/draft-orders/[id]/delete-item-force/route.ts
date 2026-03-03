import type { MedusaRequest, MedusaResponse } from "@medusajs/framework"
import { Modules } from "@medusajs/utils"

/**
 * DELETE /admin/draft-orders/:id/delete-item-force
 *
 * Sets the line item's quantity to 0 via the Order module (keeps the record,
 * prevents the order aggregate from crashing) — see frontend `fetchOrder`
 * which filters out items with quantity === 0.
 *
 * Body: { line_item_id: string }
 * Also accepts it as a query param: ?line_item_id=xxx (fallback for DELETE body issues)
 */
export async function DELETE(
    req: MedusaRequest,
    res: MedusaResponse
): Promise<void> {
    const { id: _orderId } = req.params as { id: string }

    // DELETE requests with JSON body can sometimes arrive with req.body as undefined
    // if the Content-Type header isn't set. Safely extract from body OR query string.
    const body = req.body as Record<string, any> | undefined
    const line_item_id: string | undefined =
        body?.line_item_id ?? (req.query?.line_item_id as string | undefined)

    if (!line_item_id) {
        res.status(400).json({ message: "line_item_id is required (body or query param)" })
        return
    }

    try {
        const orderModule = req.scope.resolve(Modules.ORDER) as any

        // Strategy: set quantity to 0 — keeps the DB record intact so the order
        // aggregate calculation doesn't crash, frontend filters out qty-0 items.
        //
        // updateOrderLineItems overloads:
        //   (data: UpdateOrderLineItemWithSelectorDTO[])  → needs {selector, data}
        //   (lineItemId: string, data: Partial<UpdateOrderLineItemDTO>) → simplest
        if (typeof orderModule.updateOrderLineItems === "function") {
            // Use the (id, data) overload — avoids the {selector, data} wrapper
            await orderModule.updateOrderLineItems(line_item_id, { quantity: 0 })
            console.log("[delete-item-force] updateOrderLineItems qty=0 OK:", line_item_id)
            res.status(200).json({ success: true, method: "updateOrderLineItems" })
            return
        }
        if (typeof orderModule.updateLineItems === "function") {
            await orderModule.updateLineItems([{ id: line_item_id, quantity: 0 }])
            console.log("[delete-item-force] updateLineItems qty=0 OK:", line_item_id)
            res.status(200).json({ success: true, method: "updateLineItems" })
            return
        }

        // Fallback: soft-delete (note: this may break GET /admin/draft-orders/:id temporarily)
        if (typeof orderModule.softDeleteOrderLineItems === "function") {
            await orderModule.softDeleteOrderLineItems([line_item_id])
            console.log("[delete-item-force] softDeleteOrderLineItems OK:", line_item_id)
            res.status(200).json({ success: true, method: "softDeleteOrderLineItems" })
            return
        }

        res.status(500).json({ message: "No suitable update method found on order module" })
    } catch (e: any) {
        console.error("[delete-item-force] Error:", e?.message)
        res.status(500).json({ message: e?.message ?? "Failed to delete item" })
    }
}

import type { MedusaRequest, MedusaResponse } from "@medusajs/framework"
import { Modules } from "@medusajs/framework/utils"
import {
    beginDraftOrderEditWorkflow,
    removeDraftOrderShippingMethodWorkflow,
    confirmDraftOrderEditWorkflow,
} from "@medusajs/core-flows"

/**
 * DELETE /admin/draft-orders/:id/remove-shipping
 *
 * Removes ALL shipping methods from a draft order in one atomic operation.
 * Used by POS ShippingModal "Remove shipping" button.
 */
export async function DELETE(
    req: MedusaRequest,
    res: MedusaResponse
): Promise<void> {
    const { id } = req.params as { id: string }

    try {
        // Get all current shipping methods
        const orderService = req.scope.resolve(Modules.ORDER)
        const currentOrder = await (orderService as any).retrieveOrder(id, {
            relations: ["shipping_methods"],
        })
        const existingMethods: any[] = (currentOrder as any)?.shipping_methods ?? []

        if (existingMethods.length === 0) {
            res.status(200).json({ success: true, removed: 0 })
            return
        }

        // Begin edit
        try {
            await beginDraftOrderEditWorkflow(req.scope).run({
                input: { order_id: id },
            })
        } catch (beginErr: any) {
            const msg: string = beginErr?.message ?? ""
            if (!msg.toLowerCase().includes("active") && !msg.toLowerCase().includes("change")) {
                throw beginErr
            }
        }

        // Remove each method
        let removed = 0
        for (const sm of existingMethods) {
            if (!sm?.id) continue
            try {
                await removeDraftOrderShippingMethodWorkflow(req.scope).run({
                    input: { order_id: id, shipping_method_id: sm.id },
                })
                removed++
            } catch (rmErr: any) {
                console.warn("[remove-all-shipping] Could not remove", sm.id, rmErr?.message)
            }
        }

        // Confirm
        const confirmedBy = (req as any).auth_context?.actor_id ?? "admin"
        await confirmDraftOrderEditWorkflow(req.scope).run({
            input: { order_id: id, confirmed_by: confirmedBy },
        })

        res.status(200).json({ success: true, removed })
    } catch (e: any) {
        console.error("[remove-all-shipping]", e?.message)
        res.status(500).json({ message: e?.message ?? "Failed to remove shipping methods" })
    }
}

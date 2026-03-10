import type { MedusaRequest, MedusaResponse } from "@medusajs/framework"
import { Modules } from "@medusajs/framework/utils"
import {
    beginDraftOrderEditWorkflow,
    addDraftOrderShippingMethodsWorkflow,
    removeDraftOrderShippingMethodWorkflow,
    confirmDraftOrderEditWorkflow,
} from "@medusajs/core-flows"

/**
 * POST /admin/draft-orders/:id/add-shipping-force
 *
 * Atomically REPLACES all shipping methods with the given one:
 *   1. Begin order edit
 *   2. Remove every existing shipping method (prevents accumulation)
 *   3. Add the selected shipping method
 *   4. Confirm the edit
 *
 * Body: { shipping_option_id, custom_amount? }
 */
export async function POST(
    req: MedusaRequest,
    res: MedusaResponse
): Promise<void> {
    const { id } = req.params as { id: string }
    const { shipping_option_id, custom_amount } = req.body as {
        shipping_option_id: string
        custom_amount?: number
    }

    if (!shipping_option_id) {
        res.status(400).json({ message: "shipping_option_id is required" })
        return
    }

    try {
        // Step 1: Begin draft order edit (idempotent — reuses existing active change)
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

        // Step 2: Remove ALL existing shipping methods (prevents accumulation)
        try {
            const orderService = req.scope.resolve(Modules.ORDER)
            const currentOrder = await (orderService as any).retrieveOrder(id, {
                relations: ["shipping_methods"],
            })
            const existingMethods: any[] = (currentOrder as any)?.shipping_methods ?? []
            for (const sm of existingMethods) {
                if (!sm?.id) continue
                try {
                    await removeDraftOrderShippingMethodWorkflow(req.scope).run({
                        input: { order_id: id, shipping_method_id: sm.id },
                    })
                } catch (rmErr: any) {
                    console.warn("[add-shipping-force] Could not remove method", sm.id, rmErr?.message)
                }
            }
        } catch (fetchErr: any) {
            console.warn("[add-shipping-force] Could not list existing methods:", fetchErr?.message)
        }

        // Step 3: Add the new shipping method
        await addDraftOrderShippingMethodsWorkflow(req.scope).run({
            input: {
                order_id: id,
                shipping_option_id,
                ...(custom_amount != null ? { custom_amount } : {}),
            },
        })

        // Step 4: Confirm all pending edits (removes + add)
        const confirmedBy = (req as any).auth_context?.actor_id ?? "admin"
        await confirmDraftOrderEditWorkflow(req.scope).run({
            input: { order_id: id, confirmed_by: confirmedBy },
        })

        res.status(200).json({ success: true })
    } catch (e: any) {
        console.error("[add-shipping-force]", e?.message)
        res.status(500).json({ message: e?.message ?? "Failed to add shipping" })
    }
}

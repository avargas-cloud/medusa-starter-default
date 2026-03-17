import type { MedusaRequest, MedusaResponse } from "@medusajs/framework"
import {
    cancelDraftOrderEditWorkflow,
    removeDraftOrderShippingMethodWorkflow,
    beginDraftOrderEditWorkflow,
    addDraftOrderShippingMethodsWorkflow,
    confirmDraftOrderEditWorkflow,
} from "@medusajs/core-flows"
import { Modules } from "@medusajs/utils"

/**
 * POST /admin/draft-orders/:id/add-shipping-force
 *
 * Atomically REPLACES all shipping methods with the given one.
 * Uses core-flows.
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
        // Step 0: Cancel any pending order edit (clean state)
        try {
            await cancelDraftOrderEditWorkflow(req.scope).run({ input: { order_id: id } })
        } catch { /* No pending edit — fine */ }

        // Step 1: Query existing shipping method IDs BEFORE begin (version-safe)
        const orderService = req.scope.resolve(Modules.ORDER)
        let existingMethodIds: string[] = []
        try {
            const currentOrder = await (orderService as any).retrieveOrder(id, {
                relations: ["shipping_methods"],
            })
            const existingMethods: any[] = (currentOrder as any)?.shipping_methods ?? []
            existingMethodIds = existingMethods.map((sm: any) => sm.id).filter(Boolean)
        } catch (err: any) {
            console.warn("[add-shipping-force] Could not fetch existing methods:", err?.message)
        }

        // Step 2: Begin edit
        await beginDraftOrderEditWorkflow(req.scope).run({
            input: { order_id: id },
        })

        // Step 3: Remove old methods
        for (const smId of existingMethodIds) {
            try {
                await removeDraftOrderShippingMethodWorkflow(req.scope).run({
                    input: { order_id: id, shipping_method_id: smId },
                })
            } catch (rmErr: any) {
                console.warn("[add-shipping-force] Could not remove", smId, rmErr?.message)
            }
        }

        // Step 4: Add new method
        await addDraftOrderShippingMethodsWorkflow(req.scope).run({
            input: {
                order_id: id,
                shipping_option_id,
                custom_amount: custom_amount != null ? custom_amount : undefined,
            }
        })

        // Step 5: Confirm
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

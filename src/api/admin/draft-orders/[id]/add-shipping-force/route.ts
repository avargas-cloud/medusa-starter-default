import type { MedusaRequest, MedusaResponse } from "@medusajs/framework"
import { Modules } from "@medusajs/framework/utils"
import {
    beginDraftOrderEditWorkflow,
    addDraftOrderShippingMethodsWorkflow,
    removeDraftOrderShippingMethodWorkflow,
    confirmDraftOrderEditWorkflow,
    cancelDraftOrderEditWorkflow,
} from "@medusajs/core-flows"

/**
 * POST /admin/draft-orders/:id/add-shipping-force
 *
 * Atomically REPLACES all shipping methods with the given one.
 *
 * CRITICAL ORDER OF OPERATIONS (version-aware):
 *   0. Cancel any pending order edit (clean state)
 *   1. Query existing shipping method IDs BEFORE beginning the new edit.
 *      (After beginDraftOrderEdit, the pending version increments, so
 *       retrieveOrder would return the new empty version — NOT the old methods.)
 *   2. Begin a fresh draft order edit
 *   3. Remove each previously-found shipping method
 *   4. Add the new shipping method
 *   5. Confirm the edit
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
            await cancelDraftOrderEditWorkflow(req.scope).run({
                input: { order_id: id },
            })
        } catch {
            // No pending edit to cancel — fine
        }

        // Step 1: Get existing shipping method IDs BEFORE starting the new edit.
        // After beginDraftOrderEditWorkflow, the pending version increments and
        // retrieveOrder returns the NEW (empty) pending version — missing the current methods.
        // We must capture them BEFORE begin.
        const orderService = req.scope.resolve(Modules.ORDER)
        let existingMethodIds: string[] = []
        try {
            const currentOrder = await (orderService as any).retrieveOrder(id, {
                relations: ["shipping_methods"],
            })
            existingMethodIds = ((currentOrder as any)?.shipping_methods ?? [])
                .map((sm: any) => sm.id)
                .filter(Boolean)
            console.log(`[add-shipping-force] Found ${existingMethodIds.length} existing method(s) to remove:`, existingMethodIds)
        } catch (fetchErr: any) {
            console.warn("[add-shipping-force] Could not fetch existing methods:", fetchErr?.message)
        }

        // Step 2: Begin a fresh draft order edit
        await beginDraftOrderEditWorkflow(req.scope).run({
            input: { order_id: id },
        })

        // Step 3: Remove each previously-found shipping method
        // (IDs captured before begin, so they're at the committed version)
        for (const smId of existingMethodIds) {
            try {
                await removeDraftOrderShippingMethodWorkflow(req.scope).run({
                    input: { order_id: id, shipping_method_id: smId },
                })
                console.log(`[add-shipping-force] Removed shipping method ${smId}`)
            } catch (rmErr: any) {
                console.warn("[add-shipping-force] Could not remove method", smId, rmErr?.message)
            }
        }

        // Step 4: Add the new shipping method
        await addDraftOrderShippingMethodsWorkflow(req.scope).run({
            input: {
                order_id: id,
                shipping_option_id,
                ...(custom_amount != null ? { custom_amount } : {}),
            },
        })

        // Step 5: Confirm all pending edits (removes + add)
        const confirmedBy = (req as any).auth_context?.actor_id ?? "admin"
        await confirmDraftOrderEditWorkflow(req.scope).run({
            input: { order_id: id, confirmed_by: confirmedBy },
        })

        console.log(`[add-shipping-force] Successfully replaced shipping method on order ${id}`)
        res.status(200).json({ success: true })
    } catch (e: any) {
        console.error("[add-shipping-force]", e?.message)
        res.status(500).json({ message: e?.message ?? "Failed to add shipping" })
    }
}

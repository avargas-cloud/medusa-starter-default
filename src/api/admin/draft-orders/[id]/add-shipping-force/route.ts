import type { MedusaRequest, MedusaResponse } from "@medusajs/framework"
import {
    beginDraftOrderEditWorkflow,
    addDraftOrderShippingMethodsWorkflow,
    confirmDraftOrderEditWorkflow,
} from "@medusajs/core-flows"

/**
 * POST /admin/draft-orders/:id/add-shipping-force
 *
 * Adds a shipping method to a draft order in one atomic operation:
 *   1. begins a draft order edit (or reuses existing)
 *   2. adds the selected shipping method
 *   3. confirms the edit
 *
 * Body: { shipping_option_id, custom_amount? }
 *
 * This bypasses the multi-step UI flow that the standard API requires.
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
        // Step 1: Begin draft order edit (idempotent — if one already active it is reused)
        try {
            await beginDraftOrderEditWorkflow(req.scope).run({
                input: { order_id: id },
            })
        } catch (beginErr: any) {
            // "already has an active order change" — safe to continue
            const msg: string = beginErr?.message ?? ""
            if (!msg.toLowerCase().includes("active") && !msg.toLowerCase().includes("change")) {
                throw beginErr
            }
        }

        // custom_amount from frontend is already in dollars (major units).
        // addDraftOrderShippingMethodsWorkflow expects dollars → pass through directly.

        // Step 2: Add shipping method
        await addDraftOrderShippingMethodsWorkflow(req.scope).run({
            input: {
                order_id: id,
                shipping_option_id,
                ...(custom_amount != null ? { custom_amount } : {}),
            },
        })

        // Step 3: Confirm the edit so it persists on the order
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

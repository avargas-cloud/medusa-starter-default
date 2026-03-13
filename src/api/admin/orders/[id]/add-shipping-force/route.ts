import type { MedusaRequest, MedusaResponse } from "@medusajs/framework"
import { Modules } from "@medusajs/utils"

/**
 * POST /admin/orders/:id/add-shipping-force
 *
 * Sets (or replaces) the shipping method on a confirmed order WITHOUT
 * going through the order-edit workflow.
 *
 * Removes all existing shipping methods, then creates a new one directly
 * via the Order module — same as the draft-order equivalent.
 *
 * Body: { shipping_option_id: string, custom_amount?: number }
 *       custom_amount is in DOLLARS (not cents)
 */
export async function POST(req: MedusaRequest, res: MedusaResponse): Promise<void> {
    const { id } = req.params as { id: string }
    const { shipping_option_id, custom_amount } = req.body as {
        shipping_option_id: string
        custom_amount?: number   // DOLLARS
    }

    if (!shipping_option_id) {
        res.status(400).json({ message: "shipping_option_id is required" })
        return
    }

    const base = `http://localhost:${process.env.PORT ?? 9000}`
    const authHeaders: Record<string, string> = {
        "Cookie": String(req.headers["cookie"] ?? ""),
        "Authorization": String(req.headers["authorization"] ?? ""),
        "Content-Type": "application/json",
    }

    try {
        const orderModule = req.scope.resolve(Modules.ORDER) as any

        // 1. Fetch existing shipping methods to remove them
        const orderRes = await fetch(
            `${base}/admin/orders/${id}?fields=+shipping_methods.*`,
            { headers: authHeaders }
        )
        if (orderRes.ok) {
            const { order } = await orderRes.json()
            const existingMethods: any[] = order?.shipping_methods ?? []
            for (const sm of existingMethods) {
                try {
                    if (typeof orderModule.deleteOrderShippingMethods === "function") {
                        await orderModule.deleteOrderShippingMethods([sm.id])
                        console.log(`[orders/add-shipping-force] Removed shipping method: ${sm.id}`)
                    }
                } catch (e: any) {
                    console.warn(`[orders/add-shipping-force] Could not remove ${sm.id}:`, e?.message)
                }
            }
        }

        // 2. Fetch shipping option name for the new method
        let shippingOptionName = "Shipping"
        try {
            const soRes = await fetch(`${base}/admin/shipping-options/${shipping_option_id}`, { headers: authHeaders })
            if (soRes.ok) {
                const { shipping_option } = await soRes.json()
                shippingOptionName = shipping_option?.name ?? "Shipping"
            }
        } catch { /* non-fatal */ }

        // 3. Create the new shipping method directly on the order
        const amountDollars = custom_amount ?? 0
        await orderModule.createOrderShippingMethods(id, [{
            shipping_option_id,
            name: shippingOptionName,
            amount: amountDollars,  // Order module expects dollars (same as line items)
        }])

        console.log(`[orders/add-shipping-force] Applied ${shippingOptionName} ($${amountDollars}) to order ${id}`)
        res.status(200).json({ success: true })
    } catch (e: any) {
        console.error("[orders/add-shipping-force]", e?.message)
        res.status(500).json({ message: e?.message ?? "Failed to update shipping" })
    }
}

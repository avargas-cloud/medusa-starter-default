import type { MedusaRequest, MedusaResponse } from "@medusajs/framework"
import { Modules } from "@medusajs/utils"
import { Pool } from "pg"

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
        shipping_option_id?: string | null
        custom_amount?: number   // DOLLARS
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

        // 3. Create the new shipping method directly on the order if provided
        if (shipping_option_id) {
            const amountDollars = custom_amount ?? 0
            await orderModule.createOrderShippingMethods(id, [{
                shipping_option_id,
                name: shippingOptionName,
                amount: amountDollars,  // Order module expects dollars (same as line items)
            }])
            console.log(`[orders/add-shipping-force] Applied ${shippingOptionName} ($${amountDollars}) to order ${id}`)

            // 4. Insert a 0% tax_line for the new shipping method.
            // Shipping is never taxed, but Medusa Admin requires tax_lines to exist
            // on each shipping method or crashes when the user expands "Shipping Subtotal".
            const dbUrl = process.env.DATABASE_URL
            if (dbUrl) {
                const pool = new Pool({ connectionString: dbUrl })
                try {
                    // Find the newly created shipping method for this order
                    const smRes = await pool.query<{ id: string }>(
                        `SELECT id FROM order_shipping_method
                         WHERE order_id = $1 AND deleted_at IS NULL
                         ORDER BY created_at DESC LIMIT 1`,
                        [id]
                    )
                    const shippingMethodId = smRes.rows[0]?.id
                    if (shippingMethodId) {
                        const taxLineId = `taxline_sm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
                        await pool.query(
                            `INSERT INTO order_shipping_method_tax_line
                             (id, shipping_method_id, code, rate, raw_rate, description, created_at, updated_at)
                             VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
                             ON CONFLICT DO NOTHING`,
                            [
                                taxLineId,
                                shippingMethodId,
                                'EXEMPT',
                                0,
                                JSON.stringify({ value: '0', precision: 20 }),
                                'Shipping Not Taxed',
                            ]
                        )
                        console.log(`[orders/add-shipping-force] ✅ Inserted 0% tax_line for shipping method ${shippingMethodId}`)
                    }
                } catch (te: any) {
                    console.warn(`[orders/add-shipping-force] Tax line insert failed (non-fatal):`, te?.message)
                } finally {
                    await pool.end()
                }
            }
        } else {
            console.log(`[orders/add-shipping-force] Cleared shipping methods from order ${id}`)
        }

        res.status(200).json({ success: true })
    } catch (e: any) {
        console.error("[orders/add-shipping-force]", e?.message)
        res.status(500).json({ message: e?.message ?? "Failed to update shipping" })
    }
}

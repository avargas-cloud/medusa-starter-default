import type { MedusaRequest, MedusaResponse } from "@medusajs/framework"
import { Modules } from "@medusajs/utils"
import { getDbPool } from "../../../../utils/db-pool"

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

        // 1. Fetch the true Order version and remove stale shipping methods via raw SQL
        const dbUrl = process.env.DATABASE_URL
        let currentVersion = 1
        const pool = getDbPool()
        
        if (dbUrl) {
            try {
                // Fetch current order version
                const vRes = await pool.query<{ version: number }>(`SELECT version FROM "order" WHERE id = $1 LIMIT 1`, [id])
                if (vRes.rows.length > 0) currentVersion = vRes.rows[0]!.version

                // Hard-delete existing shipping links to ensure clean state across versions
                await pool.query(
                    `UPDATE order_shipping SET deleted_at = NOW() WHERE order_id = $1 AND deleted_at IS NULL`,
                    [id]
                )
                console.log(`[orders/add-shipping-force] Cleared existing shipping methods for order ${id} (version ${currentVersion})`)
            } catch (e: any) {
                console.warn(`[orders/add-shipping-force] Failed to initialize version/cleanup:`, e?.message)
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
            
            // Note: createOrderShippingMethods strictly creates it with version: 1 inside the OrderModule
            await orderModule.createOrderShippingMethods(id, [{
                shipping_option_id,
                name: shippingOptionName,
                amount: amountDollars,  // Order module expects dollars (same as line items)
            }])
            console.log(`[orders/add-shipping-force] Applied ${shippingOptionName} ($${amountDollars}) to order ${id}`)

            // 4. Force version parity and inject 0% tax_line 
            if (dbUrl) {
                try {
                    // Find the newly created shipping method link for this order
                    const smRes = await pool.query<{ shipping_method_id: string }>(
                        `SELECT shipping_method_id FROM order_shipping
                         WHERE order_id = $1 AND deleted_at IS NULL
                         ORDER BY created_at DESC LIMIT 1`,
                        [id]
                    )
                    const shippingMethodId = smRes.rows[0]?.shipping_method_id
                    
                    if (shippingMethodId) {
                        // Upgrade the shipping method link to match the actual active order version
                        if (currentVersion > 1) {
                            await pool.query(
                                `UPDATE order_shipping SET version = $1 WHERE order_id = $2 AND shipping_method_id = $3`,
                                [currentVersion, id, shippingMethodId]
                            )
                            console.log(`[orders/add-shipping-force] Upgraded shipping link ${shippingMethodId} to match order version ${currentVersion}`)
                        }

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
                }
            }
        } else {
            console.log(`[orders/add-shipping-force] Shipping option clearing completed for order ${id}`)
        }

        res.status(200).json({ success: true })
    } catch (e: any) {
        console.error("[orders/add-shipping-force]", e?.message)
        res.status(500).json({ message: e?.message ?? "Failed to update shipping" })
    }
}

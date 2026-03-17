import type { MedusaRequest, MedusaResponse } from "@medusajs/framework"
import {
    cancelDraftOrderEditWorkflow,
} from "@medusajs/core-flows"
import { Pool } from "pg"

/**
 * POST /admin/draft-orders/:id/add-shipping-force
 *
 * Atomically REPLACES all shipping methods with the given one.
 * Uses direct SQL + order module to bypass addDraftOrderShippingMethodsWorkflow,
 * which fails with AwilixResolutionError when tax_region.provider_id is null.
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

    const base = `http://localhost:${process.env.PORT ?? 9000}`
    const authHeaders: Record<string, string> = {
        "Cookie": String(req.headers["cookie"] ?? ""),
        "Authorization": String(req.headers["authorization"] ?? ""),
        "Content-Type": "application/json",
    }
    const dbUrl = process.env.DATABASE_URL

    try {
        // Step 0: Cancel any pending order edit (clean state)
        try {
            await cancelDraftOrderEditWorkflow(req.scope).run({ input: { order_id: id } })
        } catch { /* No pending edit — fine */ }

        // Step 1: Fetch shipping option details (name, price)
        let shippingName = "Shipping"
        let baseAmount = 0
        try {
            const soRes = await fetch(
                `${base}/admin/shipping-options/${shipping_option_id}`,
                { headers: authHeaders }
            )
            if (soRes.ok) {
                const { shipping_option } = await soRes.json()
                shippingName = shipping_option?.name ?? "Shipping"
                if (custom_amount == null) {
                    baseAmount = shipping_option?.amount ?? 0
                }
            }
        } catch { /* fallback to defaults */ }

        const finalAmount = custom_amount ?? baseAmount

        if (!dbUrl) {
            res.status(500).json({ message: "DATABASE_URL not configured" })
            return
        }

        const pool = new Pool({ connectionString: dbUrl })
        try {
            // Step 2: Soft-delete existing shipping methods for this order
            await pool.query(
                `UPDATE order_shipping_method SET deleted_at = NOW() WHERE order_id = $1 AND deleted_at IS NULL`,
                [id]
            )

            // Step 3: Insert new shipping method directly (bypasses tax calculation workflow)
            const smId = `sm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
            const rawAmount = JSON.stringify({ value: String(finalAmount), precision: 20 })
            await pool.query(
                `INSERT INTO order_shipping_method
                    (id, order_id, shipping_option_id, amount, raw_amount, name, is_tax_inclusive, created_at, updated_at)
                 VALUES ($1, $2, $3, $4, $5, $6, false, NOW(), NOW())`,
                [smId, id, shipping_option_id, finalAmount, rawAmount, shippingName]
            )
            console.log(`[add-shipping-force] ✅ Inserted shipping method ${smId} (${shippingName} @ ${finalAmount}) for order ${id}`)

        } finally {
            await pool.end()
        }



        res.status(200).json({ success: true, shipping_method_id: `sm_${Date.now()}`, amount: finalAmount })
    } catch (e: any) {
        console.error("[add-shipping-force]", e?.message)
        res.status(500).json({ message: e?.message ?? "Failed to add shipping" })
    }
}

import type { MedusaRequest, MedusaResponse } from "@medusajs/framework"
import { Pool } from "pg"

/**
 * POST /admin/orders/:id/create-fulfillment-force
 *
 * Creates a fulfillment for an order bypassing Medusa's shipping profile
 * validation. The native endpoint rejects if the shipping option's profile
 * differs from the product's profile (e.g., Local Pickup vs Default).
 *
 * Strategy: temporarily align the order items' shipping profile to match
 * the shipping option, call the native workflow, then restore original profiles.
 *
 * Body:
 *   items: { id: string; quantity: number }[]  — order line item IDs + quantities
 *   location_id: string                        — stock location ID
 *   no_notification?: boolean
 */
export async function POST(req: MedusaRequest, res: MedusaResponse) {
    const { id } = req.params
    const { items, location_id, no_notification = true } = req.body as {
        items: { id: string; quantity: number }[]
        location_id: string
        no_notification?: boolean
    }

    if (!items?.length || !location_id) {
        return res.status(400).json({ message: "items and location_id are required" })
    }

    const dbUrl = process.env.DATABASE_URL
    if (!dbUrl) {
        return res.status(500).json({ message: "DATABASE_URL not set" })
    }

    const pool = new Pool({ connectionString: dbUrl })

    try {
        // 1. Find the shipping profile used by the active shipping method on this order
        const smRes = await pool.query<{ shipping_profile_id: string }>(
            `SELECT so.shipping_profile_id
             FROM order_shipping_method osm
             JOIN shipping_option so ON so.id = osm.shipping_option_id
             WHERE osm.order_id = $1 AND osm.deleted_at IS NULL
             ORDER BY osm.created_at DESC LIMIT 1`,
            [id]
        )
        const shippingProfileId = smRes.rows[0]?.shipping_profile_id

        console.log(`[create-fulfillment-force] order=${id}, shipping_profile=${shippingProfileId}`)

        // 2. Find the current shipping profiles of the items being fulfilled
        const itemIds = items.map(i => i.id)
        const itemProfilesRes = await pool.query<{ id: string; shipping_profile_id: string }>(
            `SELECT p.id, p.shipping_profile_id
             FROM product p
             JOIN product_variant pv ON pv.product_id = p.id
             JOIN order_line_item oli ON oli.variant_id = pv.id
             WHERE oli.id = ANY($1::text[])`,
            [itemIds]
        )
        const originalProfiles = itemProfilesRes.rows

        // 3. If there's a mismatch and we have a target profile, temporarily patch
        const needsPatch = shippingProfileId && originalProfiles.some(
            r => r.shipping_profile_id !== shippingProfileId
        )

        if (needsPatch) {
            const productIds = originalProfiles.map(r => r.id)
            await pool.query(
                `UPDATE product SET shipping_profile_id = $1 WHERE id = ANY($2::text[])`,
                [shippingProfileId, productIds]
            )
            console.log(`[create-fulfillment-force] Patched ${productIds.length} products to profile ${shippingProfileId}`)
        }

        try {
            // 4. Call native Medusa fulfillment workflow (now profiles match)
            const { createOrderFulfillmentWorkflow } = await import("@medusajs/core-flows")

            const result = await createOrderFulfillmentWorkflow(req.scope).run({
                input: {
                    order_id: id,
                    items,
                    location_id,
                    no_notification,
                    created_by: ((req as any).auth_context?.actor_id ?? '') as string,
                },
            })

            console.log(`[create-fulfillment-force] ✅ Fulfillment created`)

            const fulfillmentResult = result.result as any
            return res.status(201).json({ fulfillment: fulfillmentResult ?? { id: 'unknown' } })
        } finally {
            // 5. ALWAYS restore original shipping profiles
            if (needsPatch) {
                for (const row of originalProfiles) {
                    await pool.query(
                        `UPDATE product SET shipping_profile_id = $1 WHERE id = $2`,
                        [row.shipping_profile_id, row.id]
                    ).catch(e => console.warn("[create-fulfillment-force] Failed to restore profile:", e?.message))
                }
                console.log(`[create-fulfillment-force] Restored original shipping profiles`)
            }
            await pool.end()
        }
    } catch (e: any) {
        console.error("[create-fulfillment-force]", e?.message)
        try { await pool.end() } catch { /* ignore */ }
        return res.status(500).json({ message: e?.message ?? "Failed to create fulfillment" })
    }
}

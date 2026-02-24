import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { Client } from "pg"

// CORS helper (same pattern as shipping-settings)
function setCorsHeaders(req: MedusaRequest, res: MedusaResponse) {
    const origin = req.headers.origin || ""
    const allowedOrigins = (process.env.STORE_CORS || "http://localhost:4321,http://localhost:8000").split(",")
    if (
        allowedOrigins.includes(origin) ||
        origin.startsWith("http://localhost") ||
        origin.startsWith("https://localhost")
    ) {
        res.setHeader("Access-Control-Allow-Origin", origin)
    }
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS")
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-publishable-api-key")
    res.setHeader("Access-Control-Allow-Credentials", "true")
}

export const OPTIONS = async (req: MedusaRequest, res: MedusaResponse) => {
    setCorsHeaders(req, res)
    res.status(204).end()
}

/**
 * GET /shipping-preview?cart_id=cart_xxx
 *
 * Fast endpoint (~100-150ms) that returns the correct ground shipping price,
 * including long-item detection via direct DB query.
 * Used by frontend to set accurate optimistic rates before UPS rates load.
 */
export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
    setCorsHeaders(req, res)

    const cartId = req.query?.cart_id as string | undefined
    if (!cartId) {
        res.status(400).json({ error: "cart_id query param required" })
        return
    }

    const client = new Client({ connectionString: process.env.DATABASE_URL })

    try {
        await client.connect()

        // 1. Fetch shipping settings and cart items in parallel
        const [settingsResult, itemsResult] = await Promise.all([
            client.query(`
                SELECT
                    free_shipping_minimum,
                    regular_ground_shipping_price,
                    long_item_ground_shipping_price,
                    override_ups_ground
                FROM shipping_settings
                LIMIT 1
            `),
            client.query(`
                SELECT
                    cli.product_id,
                    cli.variant_id,
                    cli.unit_price,
                    cli.quantity
                FROM cart_line_item cli
                WHERE cli.cart_id = $1
                  AND cli.deleted_at IS NULL
            `, [cartId])
        ])

        const settings = settingsResult.rows[0] || {
            free_shipping_minimum: 20000,
            regular_ground_shipping_price: 1499,
            long_item_ground_shipping_price: 3499,
            override_ups_ground: true
        }

        const items = itemsResult.rows

        // 2. Calculate cart total in cents
        const cartTotalCents = items.reduce((sum: number, item: any) => {
            return sum + Math.round(item.unit_price * item.quantity * 100)
        }, 0)

        const isFree = cartTotalCents >= settings.free_shipping_minimum

        // 3. Check for long items by dimensions (> 30") — reads inventory_item first, then variant fallback
        let isLong = false
        if (!isFree && items.length > 0) {
            const variantIds = items.map((i: any) => i.variant_id).filter(Boolean)
            const productIds = items.map((i: any) => i.product_id).filter(Boolean)
            const LONG_THRESHOLD = 30  // inches — same as box-packing.ts

            if (variantIds.length > 0) {
                // Primary: inventory_item dimensions (where the admin widget saves)
                const longViaInv = await client.query(`
                    SELECT pv.id, pv.sku, ii.length, ii.width, ii.height
                    FROM product_variant pv
                    JOIN product_variant_inventory_item pvii ON pvii.variant_id = pv.id
                    JOIN inventory_item ii ON ii.id = pvii.inventory_item_id
                    WHERE pv.id = ANY($1)
                      AND (ii.length > $2 OR ii.width > $2 OR ii.height > $2)
                    LIMIT 1
                `, [variantIds, LONG_THRESHOLD])

                if (longViaInv.rows.length > 0) {
                    isLong = true
                } else {
                    // Fallback: product_variant dimensions
                    const longViaVariant = await client.query(`
                        SELECT id FROM product_variant
                        WHERE id = ANY($1)
                          AND (length > $2 OR width > $2 OR height > $2)
                        LIMIT 1
                    `, [variantIds, LONG_THRESHOLD])
                    isLong = longViaVariant.rows.length > 0
                }
            } else if (productIds.length > 0) {
                const longResult = await client.query(`
                    SELECT pv.id FROM product_variant pv
                    WHERE pv.product_id = ANY($1)
                      AND (pv.length > $2 OR pv.width > $2 OR pv.height > $2)
                    LIMIT 1
                `, [productIds, LONG_THRESHOLD])
                isLong = longResult.rows.length > 0
            }
        }

        // 4. Calculate ground shipping price
        let priceCents = 0
        if (isFree) {
            priceCents = 0
        } else if (isLong) {
            priceCents = settings.long_item_ground_shipping_price
        } else {
            priceCents = settings.regular_ground_shipping_price
        }

        res.json({
            ground: {
                price: priceCents / 100,      // dollars — what frontend reads via preview.ground.price
                price_cents: priceCents,       // kept for reference
                is_free: isFree,
                is_long: isLong
            },
            settings,
            cart_total_cents: cartTotalCents
        })

    } catch (error: any) {
        console.error("Error in /shipping-preview:", error)
        res.status(500).json({ error: "Failed to calculate shipping preview", details: error.message })
    } finally {
        await client.end()
    }
}

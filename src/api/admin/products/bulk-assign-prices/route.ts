/**
 * Bulk Assign Prices - Admin API Route
 * 
 * POST /admin/products/bulk-assign-prices
 * 
 * Assigns placeholder prices to all product variants:
 * - Retail: $10.00 USD
 * - Wholesale: $9.25 USD (10% off, rounded)
 */

import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"

// Helper: Round to .25, .50, .75, or .99
function smartRound(price: number): number {
    const dollars = Math.floor(price)
    const cents = price - dollars

    if (cents < 0.25) return dollars + 0.25
    if (cents < 0.50) return dollars + 0.50
    if (cents < 0.75) return dollars + 0.75
    return dollars + 0.99
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
    const logger = req.scope.resolve("logger")
    const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)

    logger.info("💰 Starting Bulk Price Assignment...")

    try {
        // Get all variants
        const { data: variants } = await query.graph({
            entity: "product_variant",
            fields: ["id", "sku", "title", "product.*"],
        })

        logger.info(`Found ${variants.length} variants`)

        const retailPrice = 10.00
        const wholesalePrice = smartRound(retailPrice * 0.9)

        logger.info(`Retail: $${retailPrice}, Wholesale: $${wholesalePrice}`)

        let updated = 0
        const errors: string[] = []

        // Update each variant via Admin SDK
        for (const variant of variants) {
            try {
                // Use the admin update endpoint
                await fetch(
                    `http://localhost:9000/admin/products/${variant.product.id}/variants/${variant.id}`,
                    {
                        method: "POST",
                        headers: {
                            "Content-Type": "application/json",
                            "Authorization": req.headers.authorization || "",
                        },
                        body: JSON.stringify({
                            prices: [
                                {
                                    amount: Math.round(retailPrice * 100),
                                    currency_code: "usd",
                                },
                                {
                                    amount: Math.round(wholesalePrice * 100),
                                    currency_code: "usd",
                                    rules: {
                                        customer_group_id: "cusgroup_01KFTSDZQWYBC4523HJ38DZVE7" // Wholesale group
                                    }
                                }
                            ]
                        })
                    }
                )

                updated++

                if (updated % 50 === 0) {
                    logger.info(`Updated ${updated}/${variants.length} variants...`)
                }
            } catch (error: any) {
                errors.push(`${variant.sku}: ${error.message}`)
            }
        }

        logger.info(`✅ Completed! Updated ${updated}/${variants.length} variants`)

        return res.json({
            success: true,
            updated,
            total: variants.length,
            failed: variants.length - updated,
            errors: errors.slice(0, 10), // First 10 errors only
        })

    } catch (error: any) {
        logger.error(`❌ Error: ${error.message}`)
        return res.status(500).json({
            success: false,
            error: error.message,
        })
    }
}

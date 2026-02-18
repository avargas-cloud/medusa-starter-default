import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { Client } from "pg"

// Enable CORS for this endpoint
export const CORS = {
    origin: (process.env.STORE_CORS || "http://localhost:4321").split(","),
    credentials: true,
}

export const GET = async (
    _req: MedusaRequest,
    res: MedusaResponse
) => {
    const client = new Client({
        connectionString: process.env.DATABASE_URL
    })

    try {
        await client.connect()

        const result = await client.query(`
            SELECT 
                free_shipping_minimum,
                regular_ground_shipping_price,
                long_item_ground_shipping_price,
                override_ups_ground
            FROM shipping_settings
            LIMIT 1
        `)

        // If no settings exist, return defaults
        if (result.rows.length === 0) {
            res.json({
                settings: {
                    free_shipping_minimum: 20000, // $200 default
                    regular_ground_shipping_price: 1499, // $14.99 default
                    long_item_ground_shipping_price: 3499, // $34.99 default
                    override_ups_ground: true
                }
            })
            return
        }

        res.json({
            settings: result.rows[0]
        })

    } catch (error: any) {
        console.error("Error fetching shipping settings:", error)
        res.status(500).json({
            error: "Failed to fetch shipping settings",
            details: error.message
        })
    } finally {
        await client.end()
    }
}

import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { Client } from "pg"

// Helper to set CORS headers
function setCorsHeaders(req: MedusaRequest, res: MedusaResponse) {
    const origin = req.headers.origin || ""
    const allowedOrigins = (process.env.STORE_CORS || "http://localhost:4321,http://localhost:8000").split(",")
    if (allowedOrigins.includes(origin) || origin.startsWith("http://localhost")) {
        res.setHeader("Access-Control-Allow-Origin", origin)
    }
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS")
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization")
    res.setHeader("Access-Control-Allow-Credentials", "true")
}

// Handle CORS preflight
export const OPTIONS = async (req: MedusaRequest, res: MedusaResponse) => {
    setCorsHeaders(req, res)
    res.status(204).end()
}

export const GET = async (
    req: MedusaRequest,
    res: MedusaResponse
) => {
    setCorsHeaders(req, res)

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

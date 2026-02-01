import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { Client } from "pg"

/**
 * GET /admin/quickbooks/config
 * Returns current QuickBooks configuration
 */
export async function GET(
    req: MedusaRequest,
    res: MedusaResponse
): Promise<void> {
    const client = new Client({
        connectionString: process.env.DATABASE_URL
    })

    try {
        await client.connect()

        const result = await client.query(`
            SELECT 
                id,
                inventory_interval_minutes,
                price_interval_minutes,
                last_inventory_sync,
                last_price_sync,
                bridge_url,
                created_at,
                updated_at
            FROM quickbooks_config
            WHERE id = 'default'
        `)

        if (result.rows.length === 0) {
            res.status(404).json({
                error: "Configuration not found"
            })
            return
        }

        res.json({
            config: result.rows[0]
        })

    } catch (error: any) {
        console.error("Error fetching QB config:", error)
        res.status(500).json({
            error: "Failed to fetch configuration"
        })
    } finally {
        await client.end()
    }
}

/**
 * POST /admin/quickbooks/config
 * Updates QuickBooks configuration intervals
 */
export async function POST(
    req: MedusaRequest,
    res: MedusaResponse
): Promise<void> {
    const client = new Client({
        connectionString: process.env.DATABASE_URL
    })

    try {
        const { inventory_interval_minutes, price_interval_minutes } = req.body as {
            inventory_interval_minutes?: number
            price_interval_minutes?: number
        }

        // Validation
        if (inventory_interval_minutes !== undefined) {
            if (inventory_interval_minutes < 5 || inventory_interval_minutes > 10080) {
                res.status(400).json({
                    error: "inventory_interval_minutes must be between 5 and 10080 (7 days)"
                })
                return
            }
        }

        if (price_interval_minutes !== undefined) {
            if (price_interval_minutes < 5 || price_interval_minutes > 10080) {
                res.status(400).json({
                    error: "price_interval_minutes must be between 5 and 10080 (7 days)"
                })
                return
            }
        }

        await client.connect()

        // Build update query dynamically
        const updates: string[] = []
        const values: any[] = []
        let paramIndex = 1

        if (inventory_interval_minutes !== undefined) {
            updates.push(`inventory_interval_minutes = $${paramIndex}`)
            values.push(inventory_interval_minutes)
            paramIndex++
        }

        if (price_interval_minutes !== undefined) {
            updates.push(`price_interval_minutes = $${paramIndex}`)
            values.push(price_interval_minutes)
            paramIndex++
        }

        if (updates.length === 0) {
            res.status(400).json({
                error: "No fields to update"
            })
            return
        }

        updates.push(`updated_at = NOW()`)

        const query = `
            UPDATE quickbooks_config
            SET ${updates.join(', ')}
            WHERE id = 'default'
            RETURNING *
        `

        const result = await client.query(query, values)

        res.json({
            config: result.rows[0],
            message: "Configuration updated successfully"
        })

    } catch (error: any) {
        console.error("Error updating QB config:", error)
        res.status(500).json({
            error: "Failed to update configuration"
        })
    } finally {
        await client.end()
    }
}

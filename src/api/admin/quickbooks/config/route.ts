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
 * Accepts null to disable automatic syncs
 */
export async function POST(
    req: MedusaRequest,
    res: MedusaResponse
): Promise<void> {
    const client = new Client({
        connectionString: process.env.DATABASE_URL
    })

    try {
        const { inventory_sync_interval_minutes, price_sync_interval_minutes, customer_sync_interval_minutes } = req.body as {
            inventory_sync_interval_minutes?: number | null
            price_sync_interval_minutes?: number | null
            customer_sync_interval_minutes?: number | null
        }

        // Validation (only validate non-null numbers)
        if (inventory_sync_interval_minutes !== undefined && inventory_sync_interval_minutes !== null) {
            if (inventory_sync_interval_minutes < 1 || inventory_sync_interval_minutes > 10080) {
                res.status(400).json({
                    error: "inventory_sync_interval_minutes must be between 1 and 10080 (7 days)"
                })
                return
            }
        }

        if (price_sync_interval_minutes !== undefined && price_sync_interval_minutes !== null) {
            if (price_sync_interval_minutes < 1 || price_sync_interval_minutes > 10080) {
                res.status(400).json({
                    error: "price_sync_interval_minutes must be between 1 and 10080 (7 days)"
                })
                return
            }
        }

        await client.connect()

        // Build update query dynamically
        const updates: string[] = []
        const values: any[] = []
        let paramIndex = 1

        if (inventory_sync_interval_minutes !== undefined) {
            updates.push(`inventory_interval_minutes = $${paramIndex}`)
            values.push(inventory_sync_interval_minutes) // Can be null to disable
            paramIndex++
        }

        if (price_sync_interval_minutes !== undefined && price_sync_interval_minutes !== null) {
            if (price_sync_interval_minutes < 1 || price_sync_interval_minutes > 10080) {
                res.status(400).json({
                    error: "price_sync_interval_minutes must be between 1 and 10080 (7 days)"
                })
                return
            }
        }

        if (price_sync_interval_minutes !== undefined) {
            updates.push(`price_interval_minutes = $${paramIndex}`)
            values.push(price_sync_interval_minutes) // Can be null to disable
            paramIndex++
        }

        if (customer_sync_interval_minutes !== undefined && customer_sync_interval_minutes !== null) {
            if (customer_sync_interval_minutes < 1 || customer_sync_interval_minutes > 10080) {
                res.status(400).json({
                    error: "customer_sync_interval_minutes must be between 1 and 10080 (7 days)"
                })
                return
            }
        }

        if (customer_sync_interval_minutes !== undefined) {
            updates.push(`customer_interval_minutes = $${paramIndex}`)
            values.push(customer_sync_interval_minutes) // Can be null to disable
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

import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { Client } from "pg"
import { invalidateQbIntegrationCache } from "../../../../lib/quickbooks/qb-integration-guard"

/**
 * GET /admin/quickbooks/config
 * Returns current QuickBooks configuration
 */
export async function GET(
    _req: MedusaRequest,
    res: MedusaResponse
): Promise<void> {
    const client = new Client({ connectionString: process.env.DATABASE_URL })

    try {
        await client.connect()

        const result = await client.query(`
            SELECT 
                id,
                integration_enabled,
                inventory_interval_minutes,
                price_interval_minutes,
                customer_interval_minutes,
                last_inventory_sync,
                last_price_sync,
                last_customer_sync,
                bridge_url,
                -- Store hours
                store_hours_open_hour,
                store_hours_close_hour,
                store_sat_open,
                store_sat_open_hour,
                store_sat_close_hour,
                store_sun_open,
                store_sun_open_hour,
                store_sun_close_hour,
                store_hours_timezone,
                -- Respect hours flags
                inventory_respect_hours,
                price_respect_hours,
                customer_respect_hours,
                -- Price sync schedule
                price_sync_hour,
                price_sync_timezone,
                created_at,
                updated_at
            FROM quickbooks_config
            WHERE id = 'default'
        `)

        if (result.rows.length === 0) {
            res.status(404).json({ error: "Configuration not found" })
            return
        }

        res.json({ config: result.rows[0] })

    } catch (error: any) {
        console.error("Error fetching QB config:", error)
        res.status(500).json({ error: "Failed to fetch configuration" })
    } finally {
        await client.end()
    }
}

/**
 * POST /admin/quickbooks/config
 * Updates QuickBooks configuration — intervals, store hours, respect-hours flags, master toggle
 */
export async function POST(
    req: MedusaRequest,
    res: MedusaResponse
): Promise<void> {
    const client = new Client({ connectionString: process.env.DATABASE_URL })

    try {
        const body = req.body as Record<string, any>

        const {
            inventory_sync_interval_minutes,
            price_sync_interval_minutes,
            customer_sync_interval_minutes,
            integration_enabled,
            // Store hours
            store_hours_open_hour,
            store_hours_close_hour,
            store_sat_open,
            store_sat_open_hour,
            store_sat_close_hour,
            store_sun_open,
            store_sun_open_hour,
            store_sun_close_hour,
            store_hours_timezone,
            // Respect hours flags
            inventory_respect_hours,
            price_respect_hours,
            customer_respect_hours,
        } = body

        // Validate interval ranges
        const validateMinutes = (val: number | null | undefined, field: string): boolean => {
            if (val !== undefined && val !== null && (val < 1 || val > 10080)) {
                res.status(400).json({ error: `${field} must be between 1 and 10080 (7 days)` })
                return false
            }
            return true
        }
        if (!validateMinutes(inventory_sync_interval_minutes, 'inventory_sync_interval_minutes')) return
        if (!validateMinutes(price_sync_interval_minutes, 'price_sync_interval_minutes')) return
        if (!validateMinutes(customer_sync_interval_minutes, 'customer_sync_interval_minutes')) return

        await client.connect()

        // Build dynamic update query
        const updates: string[] = []
        const values: any[] = []
        let p = 1

        const set = (column: string, value: any) => {
            updates.push(`${column} = $${p}`)
            values.push(value)
            p++
        }

        // Intervals
        if (inventory_sync_interval_minutes !== undefined) set('inventory_interval_minutes', inventory_sync_interval_minutes)
        if (price_sync_interval_minutes !== undefined) set('price_interval_minutes', price_sync_interval_minutes)
        if (customer_sync_interval_minutes !== undefined) set('customer_interval_minutes', customer_sync_interval_minutes)

        // Master toggle
        if (integration_enabled !== undefined) set('integration_enabled', integration_enabled)

        // Store hours
        if (store_hours_open_hour !== undefined) set('store_hours_open_hour', store_hours_open_hour)
        if (store_hours_close_hour !== undefined) set('store_hours_close_hour', store_hours_close_hour)
        if (store_sat_open !== undefined) set('store_sat_open', store_sat_open)
        if (store_sat_open_hour !== undefined) set('store_sat_open_hour', store_sat_open_hour)
        if (store_sat_close_hour !== undefined) set('store_sat_close_hour', store_sat_close_hour)
        if (store_sun_open !== undefined) set('store_sun_open', store_sun_open)
        if (store_sun_open_hour !== undefined) set('store_sun_open_hour', store_sun_open_hour)
        if (store_sun_close_hour !== undefined) set('store_sun_close_hour', store_sun_close_hour)
        if (store_hours_timezone !== undefined) set('store_hours_timezone', store_hours_timezone)

        // Respect hours flags
        if (inventory_respect_hours !== undefined) set('inventory_respect_hours', inventory_respect_hours)
        if (price_respect_hours !== undefined) set('price_respect_hours', price_respect_hours)
        if (customer_respect_hours !== undefined) set('customer_respect_hours', customer_respect_hours)

        // Price sync schedule (daily at fixed hour)
        if (body.price_sync_hour !== undefined) set('price_sync_hour', body.price_sync_hour)
        if (body.price_sync_timezone !== undefined) set('price_sync_timezone', body.price_sync_timezone)

        if (updates.length === 0) {
            res.status(400).json({ error: "No fields to update" })
            return
        }

        updates.push(`updated_at = NOW()`)

        const result = await client.query(
            `UPDATE quickbooks_config SET ${updates.join(', ')} WHERE id = 'default' RETURNING *`,
            values
        )

        // Invalidate in-process cache so toggle takes effect immediately
        if (integration_enabled !== undefined) {
            invalidateQbIntegrationCache()
        }

        res.json({ config: result.rows[0], message: "Configuration updated successfully" })

    } catch (error: any) {
        console.error("Error updating QB config:", error)
        res.status(500).json({ error: "Failed to update configuration" })
    } finally {
        await client.end()
    }
}

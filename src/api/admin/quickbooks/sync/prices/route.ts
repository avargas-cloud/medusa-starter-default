import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { MedusaContainer } from "@medusajs/framework/types"
import { syncPricesCore } from "../../../../../lib/quickbooks/sync-prices-core"
import { Client } from "pg"
import { randomUUID } from "crypto"

/**
 * POST /admin/quickbooks/sync/prices
 * Trigger price sync on-demand
 */
export async function POST(
    req: MedusaRequest,
    res: MedusaResponse
): Promise<void> {
    const container = req.scope as MedusaContainer
    const client = new Client({
        connectionString: process.env.DATABASE_URL
    })

    const logId = randomUUID()
    const startedAt = new Date()

    try {
        await client.connect()

        // Create log entry (status: running)
        await client.query(`
            INSERT INTO quickbooks_logs (
                id, type, status, message, started_at, created_at
            ) VALUES ($1, $2, $3, $4, $5, $6)
        `, [logId, 'price', 'running', 'Starting price sync...', startedAt, new Date()])

        // Execute sync
        const result = await syncPricesCore(container)

        // Update log with results
        const completedAt = new Date()
        const status = result.success ? 'success' : 'error'
        const message = result.success
            ? `Synced ${result.stats.updatedPrice} prices successfully`
            : `Sync failed: ${result.error}`

        await client.query(`
            UPDATE quickbooks_logs
            SET status = $1,
                message = $2,
                stats = $3,
                completed_at = $4
            WHERE id = $5
        `, [status, message, JSON.stringify(result.stats), completedAt, logId])

        // Update last_price_sync
        if (result.success) {
            await client.query(`
                UPDATE quickbooks_config
                SET last_price_sync = $1, updated_at = $2
                WHERE id = 'default'
            `, [completedAt, new Date()])
        }

        res.json({
            success: result.success,
            stats: result.stats,
            logId,
            message
        })

    } catch (error: any) {
        console.error("Price sync error:", error)

        // Update log with error
        await client.query(`
            UPDATE quickbooks_logs
            SET status = 'error',
                message = $1,
                completed_at = $2
            WHERE id = $3
        `, [error.message, new Date(), logId]).catch(console.error)

        res.status(500).json({
            error: "Price sync failed",
            message: error.message
        })
    } finally {
        await client.end()
    }
}

import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { MedusaContainer } from "@medusajs/framework/types"
import { syncPricesCore } from "../../../../../lib/quickbooks/sync-prices-core"
import { Client } from "pg"
import { randomUUID } from "crypto"

/**
 * POST /admin/quickbooks/sync/prices
 * Trigger price sync on-demand.
 *
 * Body:
 *   { dry_run?: boolean }  — If true, shows what would change without writing anything.
 */
export async function POST(
    req: MedusaRequest,
    res: MedusaResponse
): Promise<void> {
    const container = req.scope as MedusaContainer
    const client = new Client({ connectionString: process.env.DATABASE_URL })
    const logId = randomUUID()
    const startedAt = new Date()

    // Read options before any usage
    const dryRun = !!(req.body as any)?.dry_run

    try {
        await client.connect()

        // Log start — skip for dry runs (nothing is persisted)
        if (!dryRun) {
            await client.query(`
                INSERT INTO quickbooks_logs (id, type, status, message, started_at, created_at)
                VALUES ($1, $2, $3, $4, $5, $6)
            `, [logId, 'price', 'running', 'Starting price sync...', startedAt, new Date()])
        }

        // Execute sync (passes dry run flag — no writes if dryRun=true)
        const result = await syncPricesCore(container, { dryRun })

        const retailUpdated = result.stats.updatedPrice
        const wholesaleUpdated = result.stats.updatedWholesale ?? 0

        // Update log on completion (skip for dry runs)
        if (!dryRun) {
            const completedAt = new Date()
            const status = result.success ? 'success' : 'error'
            const message = result.success
                ? `Synced ${retailUpdated} retail + ${wholesaleUpdated} wholesale prices`
                : `Sync failed: ${result.error}`

            await client.query(`
                UPDATE quickbooks_logs
                SET status = $1, message = $2, stats = $3, completed_at = $4
                WHERE id = $5
            `, [status, message, JSON.stringify(result.stats), completedAt, logId])

            if (result.success) {
                await client.query(`
                    UPDATE quickbooks_config SET last_price_sync = $1, updated_at = $2
                    WHERE id = 'default'
                `, [completedAt, new Date()])
            }
        }

        res.json({
            success: result.success,
            dryRun: result.dryRun ?? dryRun,
            stats: result.stats,
            logId: dryRun ? null : logId,
            message: dryRun
                ? `DRY RUN: ${retailUpdated} retail + ${wholesaleUpdated} wholesale prices would be updated`
                : result.success
                    ? `Synced ${retailUpdated} retail + ${wholesaleUpdated} wholesale prices`
                    : `Sync failed: ${result.error}`
        })

    } catch (error: any) {
        console.error("Price sync error:", error)

        await client.query(`
            UPDATE quickbooks_logs SET status = 'error', message = $1, completed_at = $2
            WHERE id = $3
        `, [(error as Error).message, new Date(), logId]).catch(console.error)

        res.status(500).json({
            error: "Price sync failed",
            message: (error as Error).message
        })
    } finally {
        await client.end()
    }
}

import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { MedusaContainer } from "@medusajs/framework/types"
import { syncPricesCore } from "../../../../../lib/quickbooks/sync-prices-core"
import { createSyncJob, appendLog, finishJob } from "../../../../../lib/quickbooks/sync-jobs"
import { Client } from "pg"

/**
 * POST /admin/quickbooks/sync/prices
 * Returns {started, job_id} immediately — sync streams logs via SSE.
 * Body: { dry_run?: boolean }
 */
export async function POST(
    req: MedusaRequest,
    res: MedusaResponse
): Promise<void> {
    const container = req.scope as MedusaContainer
    const dryRun = !!(req.body as any)?.dry_run
    const job = createSyncJob("prices")

    res.json({
        success: true,
        started: true,
        dryRun,
        job_id: job.id,
        message: "Price sync started — stream logs at /admin/quickbooks/sync/stream?job_id=" + job.id
    })

    setImmediate(async () => {
        const client = new Client({ connectionString: process.env.DATABASE_URL })
        try {
            await client.connect()
            appendLog(job, "🚀 Price sync started...")

            const result = await syncPricesCore(container, {
                dryRun,
                onLog: (line) => appendLog(job, line)
            })

            if (result.success) {
                appendLog(job, `✅ Done: ${result.stats.updatedPrice} retail + ${result.stats.updatedWholesale} wholesale updated`)
                if (!dryRun) {
                    await client.query(
                        `UPDATE quickbooks_config SET last_price_sync = NOW(), updated_at = NOW() WHERE id = 'default'`
                    )
                }
                finishJob(job, "done")
            } else {
                appendLog(job, `❌ Sync failed: ${result.error}`)
                finishJob(job, "error")
            }
        } catch (error: any) {
            appendLog(job, `❌ Error: ${error.message}`)
            finishJob(job, "error")
        } finally {
            await client.end()
        }
    })
}

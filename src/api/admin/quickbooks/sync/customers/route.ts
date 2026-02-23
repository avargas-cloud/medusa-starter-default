import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { syncCustomersCore } from "../../../../../lib/quickbooks/sync-customers-core"
import { createSyncJob, appendLog, finishJob } from "../../../../../lib/quickbooks/sync-jobs"
import { Client } from "pg"

/**
 * POST /admin/quickbooks/sync/customers
 * Returns {started, job_id} immediately — sync streams logs via SSE.
 */
export async function POST(
    req: MedusaRequest,
    res: MedusaResponse
): Promise<void> {
    const job = createSyncJob("customers")

    res.json({
        success: true,
        started: true,
        job_id: job.id,
        message: "Customer sync started — stream logs at /admin/quickbooks/sync/stream?job_id=" + job.id
    })

    setImmediate(async () => {
        const client = new Client({ connectionString: process.env.DATABASE_URL })
        try {
            await client.connect()
            appendLog(job, "🚀 Customer sync started...")

            const result = await syncCustomersCore(req.scope, {
                onLog: (line) => appendLog(job, line)
            })

            if (result.success) {
                const msg = `✅ Done: ${result.stats?.imported ?? 0} imported, ${result.stats?.alreadyInMedusa ?? 0} already existed`
                appendLog(job, msg)
                await client.query(
                    `UPDATE quickbooks_config SET last_customer_sync = NOW(), updated_at = NOW() WHERE id = 'default'`
                ).catch((err: any) => appendLog(job, `⚠️ Could not update last_customer_sync: ${err.message}`))
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

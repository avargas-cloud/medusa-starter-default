import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { MedusaContainer } from "@medusajs/framework/types"
import { syncInventoryCore } from "../../../../../lib/quickbooks/sync-inventory-core"
import { createSyncJob, appendLog, finishJob } from "../../../../../lib/quickbooks/sync-jobs"
import { Client } from "pg"

/**
 * POST /admin/quickbooks/sync/inventory
 *
 * Body: { dry_run?: boolean }
 *
 * DRY RUN (dry_run: true):
 *   - Responds immediately with full preview (polls QB Bridge — may take ~2-5 min)
 *
 * LIVE SYNC (dry_run: false / omitted):
 *   - Returns {started: true, job_id} immediately
 *   - Sync runs in background, logs streamed via GET /admin/quickbooks/sync/stream?job_id=xxx
 *   - Updates last_inventory_sync in DB on success
 */
export async function POST(
    req: MedusaRequest,
    res: MedusaResponse
): Promise<void> {
    const container = req.scope as MedusaContainer
    const dryRun = !!(req.body as any)?.dry_run

    // ─── DRY RUN — synchronous, returns full preview ────────────────────────
    if (dryRun) {
        try {
            const result = await syncInventoryCore(container, { dryRun: true })
            const wouldUpdate = result.stats.wouldUpdate ?? 0
            const anomalyCount = result.anomalies?.length ?? 0
            res.json({
                success: result.success,
                dryRun: true,
                stats: result.stats,
                preview: result.preview,
                anomalies: result.anomalies,
                discrepancyReport: result.discrepancyReport,
                message: result.success
                    ? `DRY RUN: ${wouldUpdate} SKUs would be updated${anomalyCount > 0 ? ` — ⚠️ ${anomalyCount} anomalies detected` : " — no anomalies"}`
                    : `Dry run failed: ${result.error}`
            })
        } catch (error: any) {
            res.status(500).json({ error: "Dry run failed", message: error.message })
        }
        return
    }

    // ─── LIVE SYNC — returns job_id, streams logs via SSE ───────────────────
    const job = createSyncJob("inventory")

    res.json({
        success: true,
        started: true,
        job_id: job.id,
        message: "Inventory sync started — stream logs at /admin/quickbooks/sync/stream?job_id=" + job.id
    })

    setImmediate(async () => {
        const client = new Client({ connectionString: process.env.DATABASE_URL })
        try {
            await client.connect()
            appendLog(job, "🚀 Inventory sync started...")

            const result = await syncInventoryCore(container, {
                dryRun: false,
                onLog: (line) => appendLog(job, line)
            })

            if (result.success) {
                appendLog(job, `✅ Done: ${result.stats.updatedStock} updated, ${result.stats.skippedNoChange} unchanged`)
                await client.query(
                    `UPDATE quickbooks_config SET last_inventory_sync = NOW(), updated_at = NOW() WHERE id = 'default'`
                )
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

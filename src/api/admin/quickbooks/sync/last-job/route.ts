import { MedusaRequest, MedusaResponse } from "@medusajs/framework"
import { getLastJobByType, SyncType } from "../../../../../lib/quickbooks/sync-jobs"

/**
 * GET /admin/quickbooks/sync/last-job?type=inventory|prices|customers
 *
 * Returns the last job_id + status for a given sync type.
 * Used by the frontend on page mount to restore "View Report" state.
 */
export async function GET(req: MedusaRequest, res: MedusaResponse): Promise<void> {
    const type = req.query.type as SyncType | undefined

    if (!type || !["inventory", "prices", "customers"].includes(type)) {
        res.status(400).json({ error: "type must be inventory | prices | customers" })
        return
    }

    const job = getLastJobByType(type)
    if (!job) {
        res.json({ job_id: null, status: null, log_count: 0 })
        return
    }

    res.json({
        job_id: job.id,
        status: job.status,
        log_count: job.logs.length,
        started_at: job.startedAt,
        finished_at: job.finishedAt ?? null,
    })
}

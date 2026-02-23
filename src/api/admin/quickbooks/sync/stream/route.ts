import { MedusaRequest, MedusaResponse } from "@medusajs/framework"
import { getSyncJob, loadPersistedReport } from "../../../../../lib/quickbooks/sync-jobs"

/**
 * GET /admin/quickbooks/sync/stream?job_id=xxx
 *
 * Server-Sent Events stream for a sync job.
 * - If job is in-memory and running: streams logs live
 * - If job is in-memory and done: instant replay of all logs + done
 * - If job is not in memory (e.g. server restarted): serves from disk report
 */
export async function GET(req: MedusaRequest, res: MedusaResponse): Promise<void> {
    const jobId = req.query.job_id as string | undefined

    if (!jobId) {
        res.status(400).json({ error: "job_id is required" })
        return
    }

    // SSE headers
    res.setHeader("Content-Type", "text/event-stream")
    res.setHeader("Cache-Control", "no-cache")
    res.setHeader("Connection", "keep-alive")
    res.setHeader("X-Accel-Buffering", "no")
    res.flushHeaders()

    const send = (payload: object) => {
        try { res.write(`data: ${JSON.stringify(payload)}\n\n`) } catch { /* client disconnected */ }
    }

    // 1. Try in-memory first
    const job = getSyncJob(jobId)
    if (job) {
        // Replay logs already captured
        for (const line of job.logs) send({ type: "log", line })

        if (job.status !== "running") {
            send({ type: "done", status: job.status })
            res.end()
            return
        }

        // Live streaming
        const onLog = (line: string) => send({ type: "log", line })
        const onDone = (status: string) => { send({ type: "done", status }); cleanup(); res.end() }
        const cleanup = () => { job.emitter.off("log", onLog); job.emitter.off("done", onDone) }

        job.emitter.on("log", onLog)
        job.emitter.on("done", onDone)
        req.on("close", cleanup)
        return
    }

    // 2. Job not in memory — try loading from disk (survives server restarts)
    // The job_id embedded in filename is by type, so we need to find which report matches
    for (const type of ["inventory", "prices", "customers"] as const) {
        const report = loadPersistedReport(type)
        if (report && report.id === jobId) {
            // Replay all logs from disk instantly
            for (const line of report.logs) send({ type: "log", line })
            send({ type: "done", status: report.status })
            res.end()
            return
        }
    }

    // 3. Not found anywhere
    send({ type: "error", message: "Report not found. It may have expired or the server was restarted before this sync ran." })
    res.end()
}

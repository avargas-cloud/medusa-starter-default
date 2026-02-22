import { MedusaRequest, MedusaResponse } from "@medusajs/framework"
import { getSyncJob } from "../../../../../lib/quickbooks/sync-jobs"

/**
 * GET /admin/quickbooks/sync/stream?job_id=xxx
 *
 * Server-Sent Events stream for a running sync job.
 * Sends:
 *   data: {"type":"log","line":"..."}
 *   data: {"type":"done","status":"done"|"error"}
 *
 * Client usage:
 *   const src = new EventSource(`/admin/quickbooks/sync/stream?job_id=${jobId}`)
 *   src.onmessage = (e) => { const msg = JSON.parse(e.data); ... }
 */
export async function GET(req: MedusaRequest, res: MedusaResponse): Promise<void> {
    const jobId = req.query.job_id as string | undefined

    if (!jobId) {
        res.status(400).json({ error: "job_id is required" })
        return
    }

    const job = getSyncJob(jobId)
    if (!job) {
        res.status(404).json({ error: "Job not found or expired" })
        return
    }

    // SSE headers
    res.setHeader("Content-Type", "text/event-stream")
    res.setHeader("Cache-Control", "no-cache")
    res.setHeader("Connection", "keep-alive")
    res.setHeader("X-Accel-Buffering", "no") // disable nginx buffering
    res.flushHeaders()

    const send = (payload: object) => {
        try {
            res.write(`data: ${JSON.stringify(payload)}\n\n`)
        } catch {
            // client disconnected — ignore
        }
    }

    // Replay existing logs (in case client connected late)
    for (const line of job.logs) {
        send({ type: "log", line })
    }

    // If job already finished, send done and close
    if (job.status !== "running") {
        send({ type: "done", status: job.status })
        res.end()
        return
    }

    // Stream new logs as they arrive
    const onLog = (line: string) => send({ type: "log", line })
    const onDone = (status: string) => {
        send({ type: "done", status })
        cleanup()
        res.end()
    }

    const cleanup = () => {
        job.emitter.off("log", onLog)
        job.emitter.off("done", onDone)
    }

    job.emitter.on("log", onLog)
    job.emitter.on("done", onDone)

    // Cleanup if client disconnects
    req.on("close", cleanup)
}

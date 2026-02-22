import { EventEmitter } from "events"

export type SyncType = "inventory" | "prices" | "customers"

export interface SyncJob {
    id: string
    type: SyncType
    status: "running" | "done" | "error"
    logs: string[]
    emitter: EventEmitter
    startedAt: Date
    finishedAt?: Date
}

// All active jobs by ID (GC'd after 8h)
const jobs = new Map<string, SyncJob>()

// Last completed/running job per type — persists for the server lifetime
// New sync of same type replaces the previous one here
const lastJobByType = new Map<SyncType, SyncJob>()

const JOB_TTL_MS = 8 * 60 * 60 * 1000 // 8 hours

export function createSyncJob(type: SyncType): SyncJob {
    const id = `${type}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const job: SyncJob = {
        id,
        type,
        status: "running",
        logs: [],
        emitter: new EventEmitter(),
        startedAt: new Date(),
    }
    job.emitter.setMaxListeners(20)
    jobs.set(id, job)
    lastJobByType.set(type, job) // replace previous — only keep the last one

    // Auto-cleanup from `jobs` map after TTL (lastJobByType keeps its ref)
    setTimeout(() => jobs.delete(id), JOB_TTL_MS)

    return job
}

export function getSyncJob(id: string): SyncJob | undefined {
    return jobs.get(id)
}

/** Get the last job for a given type (survives TTL because lastJobByType holds the ref) */
export function getLastJobByType(type: SyncType): SyncJob | undefined {
    return lastJobByType.get(type)
}

/** Append a log line and emit to all SSE listeners */
export function appendLog(job: SyncJob, line: string) {
    job.logs.push(line)
    job.emitter.emit("log", line)
}

/** Mark job done or error, emit final event */
export function finishJob(job: SyncJob, status: "done" | "error") {
    job.status = status
    job.finishedAt = new Date()
    job.emitter.emit("done", status)
}

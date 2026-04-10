import { findLatestInFlightRow, pollUntilQbConfirmed } from "./qb-pipeline"
import { withQbLock } from "./qb-locks"

interface SerializerLookup {
    orderId: string
    steps: string[]
}

interface SerializerOptions {
    maxWaitMs?: number
    logger?: { info: (msg: string) => void; warn: (msg: string) => void }
}

const DEFAULT_MAX_WAIT_MS = 5 * 60 * 1000 // 5 minutes

/**
 * DB-based serialization for QuickBooks write operations.
 *
 * Before executing `fn`, checks the pipeline table for any in-flight
 * operations on the same document. If one exists, waits for it to
 * complete (confirmed/failed/stale) before proceeding.
 *
 * Then delegates to the in-memory `withQbLock` for process-level
 * serialization (fast path for same-process concurrent calls).
 *
 * Usage:
 *   withQbSerialized("estimate:order123", { orderId: "order123", steps: ["estimate"] }, async () => {
 *       // ... your QB write logic
 *   })
 */
export function withQbSerialized(
    lockKey: string,
    lookup: SerializerLookup,
    fn: () => Promise<void>,
    options?: SerializerOptions
): Promise<void> {
    const maxWaitMs = options?.maxWaitMs ?? DEFAULT_MAX_WAIT_MS
    const log = options?.logger

    return withQbLock(lockKey, async () => {
        // DB-level check: is there an in-flight operation for this document?
        const inFlight = await findLatestInFlightRow(lookup.orderId, lookup.steps)

        if (inFlight) {
            log?.info(`[qb-serializer] In-flight row found for ${lockKey}: ${inFlight.id} (status=${inFlight.status}) — waiting...`)

            const outcome = await pollUntilQbConfirmed(inFlight.id, maxWaitMs)

            if (outcome === "timeout") {
                log?.warn(`[qb-serializer] Timed out waiting for in-flight row ${inFlight.id} (${lockKey}) — proceeding anyway`)
            } else {
                log?.info(`[qb-serializer] In-flight row ${inFlight.id} resolved (${outcome}) — proceeding with ${lockKey}`)
            }
        }

        // Execute the actual QB write operation
        await fn()
    })
}

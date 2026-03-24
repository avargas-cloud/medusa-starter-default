import { QbAsyncResult } from "./types"

export const BRIDGE_URL = process.env.QB_BRIDGE_URL || "https://qb.eptbridge.com"
export const API_KEY = process.env.QB_API_KEY || "mQb-7k9Pzx4RwN2vL8jT3bY6hF5nC1aD"
export const DRY_RUN = process.env.QB_DRY_RUN === "true"

export const POLL_INTERVAL_MS = 20_000
export const MAX_POLL_ATTEMPTS = 20

// ─── Internal fetch helper ─────────────────────────────────────────────────────

export async function bridgeFetch(
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    path: string,
    body?: object
): Promise<any> {
    const url = `${BRIDGE_URL}${path}`

    const res = await fetch(url, {
        method,
        headers: {
            "x-api-key": API_KEY,
            "Content-Type": "application/json",
            "bypass-tunnel-reminder": "true",
        },
        body: body ? JSON.stringify(body) : undefined,
    })

    if (!res.ok) {
        const text = await res.text().catch(() => "")
        throw new Error(`Bridge ${method} ${path} → ${res.status}: ${text}`)
    }

    return res.json()
}

// ─── Async Polling Helper ──────────────────────────────────────────────────────

export async function pollOperationResult(
    operationId: string,
    log: (msg: string) => void = console.log
): Promise<QbAsyncResult> {
    for (let attempt = 1; attempt <= MAX_POLL_ATTEMPTS; attempt++) {
        await new Promise(r => setTimeout(r, POLL_INTERVAL_MS))

        log(`[QB] ⏳ Polling operation ${operationId} (${attempt}/${MAX_POLL_ATTEMPTS})...`)

        try {
            const statusRes = await bridgeFetch("GET", `/api/sync/status/${operationId}`)
            const op = statusRes?.operation

            if (!op) continue

            if (op.status === "completed") {
                const txnId = op.txnId || op.result?.TxnID
                const refNumber = op.refNumber || op.result?.RefNumber
                log(`[QB] ✅ Operation completed. TxnID: ${txnId}, RefNumber: ${refNumber}`)
                return { operationId, txnId, refNumber }
            }

            if (op.status === "failed") {
                throw new Error(`QB operation ${operationId} failed: ${op.error || "Unknown error"}`)
            }

            log(`[QB]    Status: ${op.status}`)
        } catch (err: any) {
            if (err.message.includes("failed:")) throw err
            log(`[QB] ⚠️ Poll error (will retry): ${err.message}`)
        }
    }

    log(`[QB] ⏱️ Polling timed out for operation ${operationId} after ${MAX_POLL_ATTEMPTS} attempts`)
    return { operationId }
}

export async function pollRawOperationResult(operationId: string, log: (msg: string) => void = console.log): Promise<any> {
    for (let attempt = 1; attempt <= MAX_POLL_ATTEMPTS; attempt++) {
        await new Promise(r => setTimeout(r, POLL_INTERVAL_MS))
        log(`[QB] ⏳ Polling raw operation ${operationId} (${attempt}/${MAX_POLL_ATTEMPTS})...`)
        try {
            const statusRes = await bridgeFetch("GET", `/api/sync/status/${operationId}`)
            const op = statusRes?.operation
            if (!op) continue
            if (op.status === "completed") return op.result
            if (op.status === "failed") throw new Error(`QB operation ${operationId} failed: ${op.error || "Unknown error"}`)
        } catch (err: any) {
            if (err.message.includes("failed:")) throw err
            log(`[QB] ⚠️ Raw poll error (will retry): ${err.message}`)
        }
    }
    throw new Error(`Polling timed out for operation ${operationId} after ${MAX_POLL_ATTEMPTS} attempts`)
}

export async function checkBridgeHealth(): Promise<boolean> {
    try {
        const data = await bridgeFetch("GET", "/health")
        return data?.status === "healthy"
    } catch {
        return false
    }
}

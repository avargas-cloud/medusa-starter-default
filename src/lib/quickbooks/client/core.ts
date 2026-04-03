import { QbAsyncResult, QbUpdateCustomerPayload } from "./types"

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
                // EditSequence — covers ALL QB document types, Add + Mod, all nesting levels
                const r = op.result || {}
                const msgs = r.QBXML?.QBXMLMsgsRs || r.QBXMLMsgsRs || {}
                const txnId =
                    op.txnId ||
                    op.result?.TxnID ||
                    msgs?.ReceivePaymentAddRs?.ReceivePaymentRet?.TxnID ||
                    msgs?.ReceivePaymentModRs?.ReceivePaymentRet?.TxnID
                const refNumber = op.refNumber || op.result?.RefNumber
                // Customer operations return listId instead of txnId
                const listId = op.listId || op.result?.ListID
                const editSequence: string | undefined =
                    op.editSequence ||
                    r.EditSequence ||
                    // ── Add responses ──────────────────────────────────────────
                    msgs.EstimateAddRs?.EstimateRet?.EditSequence ||
                    msgs.SalesOrderAddRs?.SalesOrderRet?.EditSequence ||
                    msgs.InvoiceAddRs?.InvoiceRet?.EditSequence ||
                    msgs.SalesReceiptAddRs?.SalesReceiptRet?.EditSequence ||
                    msgs.ReceivePaymentAddRs?.ReceivePaymentRet?.EditSequence ||
                    msgs.CreditMemoAddRs?.CreditMemoRet?.EditSequence ||
                    msgs.CheckAddRs?.CheckRet?.EditSequence ||
                    msgs.ItemInventoryAddRs?.ItemInventoryRet?.EditSequence ||
                    msgs.ItemInventoryModRs?.ItemInventoryRet?.EditSequence ||
                    // ── Mod responses ──────────────────────────────────────────
                    msgs.EstimateModRs?.EstimateRet?.EditSequence ||
                    msgs.SalesOrderModRs?.SalesOrderRet?.EditSequence ||
                    msgs.InvoiceModRs?.InvoiceRet?.EditSequence ||
                    msgs.SalesReceiptModRs?.SalesReceiptRet?.EditSequence ||
                    msgs.ReceivePaymentModRs?.ReceivePaymentRet?.EditSequence ||
                    msgs.CreditMemoModRs?.CreditMemoRet?.EditSequence ||
                    msgs.CheckModRs?.CheckRet?.EditSequence ||
                    // ── Flat fallbacks (bridge may hoist Ret directly) ─────────
                    r.EstimateRet?.EditSequence ||
                    r.SalesOrderRet?.EditSequence ||
                    r.InvoiceRet?.EditSequence ||
                    r.SalesReceiptRet?.EditSequence ||
                    r.ReceivePaymentRet?.EditSequence ||
                    r.CreditMemoRet?.EditSequence ||
                    r.CheckRet?.EditSequence ||
                    undefined
                log(`[QB] ✅ Operation completed. TxnID: ${txnId ?? listId}, RefNumber: ${refNumber}`)
                // Return listId as txnId so customer callers can use result.txnId for the ListID
                return { operationId, txnId: txnId ?? listId, refNumber, listId, editSequence }
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

/**
 * Fetches the current EditSequence for a QB customer by ListID.
 * Required before any CustomerMod operation.
 */
export async function getCustomerEditSequence(
    listId: string,
    log: (msg: string) => void = console.log
): Promise<string | null> {
    try {
        // Use GET /api/customers/:listId — bridge queues a CustomerQuery by ListID
        const res = await bridgeFetch("GET", `/api/customers/${listId}`)
        const operationId: string = res?.operationId || res?.operation?.id
        if (!operationId) throw new Error("Bridge did not return operationId for CustomerQuery")

        // Poll for the query result
        for (let attempt = 1; attempt <= MAX_POLL_ATTEMPTS; attempt++) {
            await new Promise(r => setTimeout(r, POLL_INTERVAL_MS))
            const statusRes = await bridgeFetch("GET", `/api/sync/status/${operationId}`)
            const op = statusRes?.operation
            if (!op) continue
            if (op.status === "completed") {
                // Regex-extract EditSequence from the raw QB XML response (most reliable)
                const rawXml: string = op.qbxmlResponse || ""
                const match = rawXml.match(/<EditSequence>(\d+)<\/EditSequence>/)
                if (match?.[1]) return match[1]
                // Fallback to parsed result object
                const editSeq = op.result?.QBXML?.QBXMLMsgsRs?.CustomerQueryRs?.CustomerRet?.EditSequence ?? null
                if (editSeq) return String(editSeq)
                throw new Error("CustomerQuery completed but returned no EditSequence")
            }
            if (op.status === "failed") throw new Error(`CustomerQuery failed: ${op.error}`)
            log(`[QB] ⏳ Waiting for CustomerQuery ${operationId} (${attempt}/${MAX_POLL_ATTEMPTS})...`)
        }
        throw new Error("CustomerQuery polling timed out")
    } catch (err: any) {
        log(`[QB] ⚠️ getCustomerEditSequence failed: ${err.message}`)
        return null
    }
}

/**
 * Updates an existing QB customer via CustomerMod.
 * Requires ListID and EditSequence in the payload.
 */
export async function updateCustomerInQb(
    payload: QbUpdateCustomerPayload,
    log: (msg: string) => void = console.log
): Promise<{ success: boolean; error?: string }> {
    if (DRY_RUN) {
        log(`[QB DRY RUN] Would update customer ${payload.ListID}`)
        return { success: true }
    }

    try {
        const res = await bridgeFetch("POST", "/api/customers", { ...payload, action: "mod" })
        const operationId: string = res?.operationId || res?.operation?.id
        if (!operationId) throw new Error("Bridge did not return operationId for CustomerMod")

        const result = await pollOperationResult(operationId, log)
        if (!result.listId && !result.txnId) throw new Error("CustomerMod did not return confirmation")

        log(`[QB] ✅ CustomerMod completed for ${payload.ListID}`)
        return { success: true }
    } catch (err: any) {
        log(`[QB] ❌ updateCustomerInQb failed: ${err.message}`)
        return { success: false, error: err.message }
    }
}

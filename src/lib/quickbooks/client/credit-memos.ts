import { DRY_RUN, bridgeFetch, pollRawOperationResult, pollOperationResult } from "./core"
import { QbCreateCreditMemoPayload, QbBridgeResult, QbAsyncResult } from "./types"

/**
 * Creates a Credit Memo in QuickBooks (async).
 */
export async function createCreditMemoInQb(
    payload: QbCreateCreditMemoPayload
): Promise<QbBridgeResult<QbAsyncResult>> {
    if (DRY_RUN) {
        console.log(`[QB DRY RUN] Would create Credit Memo in QB for customer ${payload.customerId}`)
        return { success: true, dryRun: true, data: { operationId: "DRY_RUN", txnId: "DRY_RUN_CREDIT_MEMO_TXNID", refNumber: "DRY_RUN_REF" } }
    }

    try {
        const body = {
            ...payload
        }
        const data = await bridgeFetch("POST", "/api/credit-memos", body)
        const operationId = data?.operationId
        if (!operationId) throw new Error("Bridge did not return an operationId for Credit Memo")
        return { success: true, data: { operationId } }
    } catch (err: any) {
        return { success: false, error: err.message }
    }
}

/**
 * Voids a Credit Memo in QuickBooks by TxnID.
 * Fetches EditSequence first if not provided.
 */
export async function voidCreditMemoInQb(
    txnId: string,
    editSequence?: string | null,
    log: (msg: string) => void = console.log
): Promise<QbBridgeResult<QbAsyncResult>> {
    if (DRY_RUN) {
        log(`[QB DRY RUN] Would void Credit Memo ${txnId}`)
        return { success: true, dryRun: true, data: { operationId: "DRY_RUN", txnId } }
    }

    try {
        // Fetch EditSequence if not already known
        let resolvedEditSeq = editSequence
        if (!resolvedEditSeq) {
            log(`[QB] Fetching Credit Memo ${txnId} to get EditSequence...`)
            const queryResp = await bridgeFetch("GET", `/api/credit-memos/${txnId}`)
            const queryOpId = queryResp?.operationId
            if (queryOpId) {
                const rawResult = await pollRawOperationResult(queryOpId, log)
                const cmRet =
                    rawResult?.QBXML?.QBXMLMsgsRs?.CreditMemoQueryRs?.CreditMemoRet ??
                    rawResult?.QBXMLMsgsRs?.CreditMemoQueryRs?.CreditMemoRet ??
                    rawResult?.CreditMemoRet
                resolvedEditSeq = cmRet?.EditSequence as string | undefined
                if (resolvedEditSeq) log(`[QB] EditSequence obtained: ${resolvedEditSeq}`)
            }
        }

        if (!resolvedEditSeq) {
            log(`[QB] Warning: Could not obtain EditSequence for Credit Memo ${txnId}. Proceeding anyway.`)
        }

        const data = await bridgeFetch("DELETE", `/api/credit-memos/${txnId}`)
        const operationId = data?.operationId
        if (!operationId) throw new Error("Bridge did not return operationId for Credit Memo void")

        log(`[QB] Credit Memo ${txnId} void queued (op: ${operationId})`)
        const result = await pollOperationResult(operationId, log)
        return { success: true, data: result }
    } catch (err: any) {
        return { success: false, error: err.message }
    }
}

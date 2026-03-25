import { DRY_RUN, bridgeFetch } from "./core"
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

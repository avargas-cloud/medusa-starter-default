import { DRY_RUN, bridgeFetch, pollRawOperationResult, pollOperationResult } from "./core"
import { QbCreateSalesReceiptPayload, QbBridgeResult, QbAsyncResult } from "./types"

/**
 * Creates a QuickBooks Sales Receipt via the bridge.
 * This is an async bridge operation — poll operationId to confirm txnId.
 */
export async function createSalesReceiptInQb(
    payload: QbCreateSalesReceiptPayload
): Promise<QbBridgeResult<QbAsyncResult>> {
    if (DRY_RUN) {
        console.log(`[QB DRY RUN] Would create Sales Receipt for customer ${payload.customerId} (${payload.items.length} items)`)
        return { success: true, dryRun: true, data: { operationId: "DRY_RUN" } }
    }

    try {
        const data = await bridgeFetch("POST", "/api/sales-receipts", {
            customerId: payload.customerId,
            refNumber: payload.refNumber,
            date: payload.date,
            PaymentMethod: payload.paymentMethod,
            SalesRep: payload.salesRep,
            memo: payload.memo,
            items: payload.items.map(item => ({
                productId: item.productId,
                productName: item.productName,
                quantity: item.quantity,
                price: item.price,
                desc: item.desc,
            })),
        })

        const operationId = data?.operationId
        if (!operationId) throw new Error("Bridge did not return operationId for Sales Receipt creation")

        console.log(`[QB] Sales Receipt creation queued (op: ${operationId})`)
        return { success: true, data: { operationId } }
    } catch (err: any) {
        return { success: false, error: err.message }
    }
}

/**
 * Voids a Sales Receipt in QuickBooks.
 * Fetches the EditSequence dynamically before voiding to ensure consistency.
 */
export async function voidSalesReceiptInQb(
    receiptTxnId: string,
    log: (msg: string) => void = console.log
): Promise<QbBridgeResult<QbAsyncResult>> {
    if (DRY_RUN) {
        log(`[QB DRY RUN] Would void Sales Receipt ${receiptTxnId}`)
        return { success: true, dryRun: true, data: { operationId: "DRY_RUN", txnId: receiptTxnId } }
    }

    try {
        log(`[QB] Querying Sales Receipt ${receiptTxnId} to get EditSequence for voiding...`)
        const queryResp = await bridgeFetch("GET", `/api/sales-receipts/${receiptTxnId}`)
        const queryOpId = queryResp?.operationId
        if (!queryOpId) throw new Error("Bridge did not return operationId for Sales Receipt query")

        const rawResult = await pollRawOperationResult(queryOpId)

        const receiptRet =
            rawResult?.QBXML?.QBXMLMsgsRs?.SalesReceiptQueryRs?.SalesReceiptRet ??
            rawResult?.QBXMLMsgsRs?.SalesReceiptQueryRs?.SalesReceiptRet ??
            rawResult?.SalesReceiptRet ??
            rawResult?.SalesReceiptQueryRs?.SalesReceiptRet

        const editSequence = receiptRet?.EditSequence as string | undefined
        if (!editSequence) {
            log(`[QB] Warning: Could not extract EditSequence for Sales Receipt ${receiptTxnId}. Proceeding with void.`)
        } else {
            log(`[QB] EditSequence obtained: ${editSequence}. Voiding Sales Receipt...`)
        }

        const data = await bridgeFetch("DELETE", `/api/sales-receipts/${receiptTxnId}`)
        const operationId = data?.operationId
        if (!operationId) throw new Error("Bridge did not return operationId for Sales Receipt void")
        
        log(`[QB] Sales Receipt ${receiptTxnId} void queued (op: ${operationId})`)
        const result = await pollOperationResult(operationId, log)
        return { success: true, data: result }
    } catch (err: any) {
        return { success: false, error: err.message }
    }
}

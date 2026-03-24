import { DRY_RUN, bridgeFetch, pollRawOperationResult } from "./core"
import { QbCreateSalesOrderPayload, QbUpdateSalesOrderPayload, QbBridgeResult, QbAsyncResult } from "./types"

/**
 * Creates a Sales Order in QuickBooks (async).
 * Returns operationId immediately. Caller can poll for txnId + refNumber.
 */
export async function createSalesOrderInQb(
    payload: QbCreateSalesOrderPayload
): Promise<QbBridgeResult<QbAsyncResult>> {
    if (DRY_RUN) {
        console.log(`[QB DRY RUN] Would create Sales Order for:`, payload.customerId, `(${payload.items.length} items)`)
        return { success: true, dryRun: true, data: { operationId: "DRY_RUN", txnId: "DRY_RUN_SO_TXNID", refNumber: "DRY_RUN_REF" } }
    }

    try {
        const body = {
            ...payload,
            templateRef: payload.templateRef || "Sales Order Original",
        }
        const data = await bridgeFetch("POST", "/api/sales-orders", body)
        const operationId = data?.operationId
        if (!operationId) throw new Error("Bridge did not return an operationId for Sales Order")
        return { success: true, data: { operationId } }
    } catch (err: any) {
        return { success: false, error: err.message }
    }
}

export async function getSalesOrderDetailsFromQb(txnId: string): Promise<{ success: boolean, editSequence?: string, linesByProductId?: Record<string, string>, rawLines?: any[], error?: string }> {
    try {
        console.log(`[QB] Querying Sales Order ${txnId} to get details...`)
        const queryResp = await bridgeFetch("GET", `/api/sales-orders/${txnId}`)
        const queryOpId = queryResp?.operationId
        if (!queryOpId) throw new Error("Bridge did not return operationId for SO query")

        const rawResult = await pollRawOperationResult(queryOpId)

        const soRet =
            rawResult?.QBXML?.QBXMLMsgsRs?.SalesOrderQueryRs?.SalesOrderRet ??
            rawResult?.QBXMLMsgsRs?.SalesOrderQueryRs?.SalesOrderRet ??
            rawResult?.SalesOrderRet ??
            rawResult?.SalesOrderQueryRs?.SalesOrderRet

        if (!soRet) {
            throw new Error(`Could not extract SalesOrderRet from SO query. Raw: ${JSON.stringify(rawResult).slice(0, 200)}`)
        }

        const editSequence = soRet.EditSequence as string

        const existingLines = soRet.SalesOrderLineRet
        const linesArr: any[] = Array.isArray(existingLines)
            ? existingLines
            : (existingLines ? [existingLines] : [])

        const qbLinesByProductId: Record<string, string> = {}
        for (const line of linesArr) {
            const productId = line?.ItemRef?.ListID
            const txnLineId = line?.TxnLineID
            if (productId && txnLineId) qbLinesByProductId[productId] = txnLineId
        }

        console.log(`[QB] Details obtained. ${linesArr.length} existing SO lines. First line: ${JSON.stringify(linesArr[0])}`)
        return { success: true, editSequence, linesByProductId: qbLinesByProductId, rawLines: linesArr }
    } catch (err: any) {
        return { success: false, error: err.message }
    }
}

/**
 * Updates an existing QB Sales Order (for Re-sync flow).
 *
 * Flow (2 async hops):
 *   1. GET /api/sales-orders/:txnId → poll → get EditSequence + TxnLineID(s)
 *   2. PUT /api/sales-orders/:txnId with EditSequence + items mapped by productId
 */
export async function updateSalesOrderInQb(
    payload: QbUpdateSalesOrderPayload
): Promise<QbBridgeResult<QbAsyncResult>> {
    if (DRY_RUN) {
        console.log(`[QB DRY RUN] Would update Sales Order ${payload.txnId} (${payload.items.length} items)`)
        return { success: true, dryRun: true, data: { operationId: "DRY_RUN", txnId: payload.txnId } }
    }

    try {
        const details = await getSalesOrderDetailsFromQb(payload.txnId)
        if (!details.success || !details.editSequence) {
            throw new Error(`Failed to fetch SO details: ${details.error}`)
        }
        
        const editSequence = details.editSequence
        const qbLinesByProductId = details.linesByProductId || {}

        const modItems = payload.items.map(item => {
            const pid = item.productId
            const txnLineId = pid ? qbLinesByProductId[pid] : undefined
            return {
                ...(txnLineId ? { TxnLineID: txnLineId } : {}),
                ...(pid ? { productId: pid } : {}),
                ...(item.productName ? { productName: item.productName } : {}),
                quantity: item.quantity,
                price: item.price,
                desc: item.desc,
                noSite: item.noSite,
            }
        })

        const modResp = await bridgeFetch("PUT", `/api/sales-orders/${payload.txnId}`, {
            EditSequence: editSequence,
            ...(payload.customerId ? { customerId: payload.customerId } : {}),
            ...(payload.customerName ? { customerName: payload.customerName } : {}),
            items: modItems,
            memo: payload.memo,
            ...(payload.taxExempt === true ? { taxExempt: true } : {}),
            ...(payload.salesTaxCode ? { salesTaxCode: payload.salesTaxCode } : {}),
        })

        const operationId = modResp?.operationId
        if (!operationId) throw new Error("Bridge did not return operationId for SO mod")

        console.log(`[QB] ✅ Sales Order update queued. OperationID: ${operationId}`)
        return { success: true, data: { operationId, txnId: payload.txnId } }
    } catch (err: any) {
        return { success: false, error: err.message }
    }
}

/**
 * Closes a Sales Order in QuickBooks (IsManuallyClosed = true).
 * Called when a Medusa order is cancelled before fulfillment.
 * Now ALWAYS fetches the EditSequence dynamically from QB to ensure success.
 */
export async function closeSalesOrderInQb(
    soTxnId: string,
    log: (msg: string) => void = console.log
): Promise<QbBridgeResult<QbAsyncResult>> {
    if (DRY_RUN) {
        log(`[QB DRY RUN] Would close Sales Order ${soTxnId}`)
        return { success: true, dryRun: true, data: { operationId: "DRY_RUN", txnId: soTxnId } }
    }

    try {
        log(`[QB] Querying Sales Order ${soTxnId} to get EditSequence for closing...`)
        const queryResp = await bridgeFetch("GET", `/api/sales-orders/${soTxnId}`)
        const queryOpId = queryResp?.operationId
        if (!queryOpId) throw new Error("Bridge did not return operationId for SO query")

        const rawResult = await pollRawOperationResult(queryOpId, log)

        const soRet =
            rawResult?.QBXML?.QBXMLMsgsRs?.SalesOrderQueryRs?.SalesOrderRet ??
            rawResult?.QBXMLMsgsRs?.SalesOrderQueryRs?.SalesOrderRet ??
            rawResult?.SalesOrderRet ??
            rawResult?.SalesOrderQueryRs?.SalesOrderRet

        if (!soRet?.EditSequence) {
            throw new Error(`Could not extract EditSequence from SO query. Raw: ${JSON.stringify(rawResult).slice(0, 200)}`)
        }

        const editSequence = soRet.EditSequence as string
        log(`[QB] EditSequence obtained: ${editSequence}. Closing SO...`)

        const data = await bridgeFetch("DELETE", `/api/sales-orders/${soTxnId}`, { EditSequence: editSequence })
        const operationId = data?.operationId
        if (!operationId) throw new Error("Bridge did not return operationId for Sales Order close")

        log(`[QB] Sales Order ${soTxnId} close queued (op: ${operationId})`)
        return { success: true, data: { operationId, txnId: soTxnId } }
    } catch (err: any) {
        return { success: false, error: err.message }
    }
}

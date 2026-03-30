import { DRY_RUN, bridgeFetch, pollOperationResult } from "./core"
import { QbCreateCheckPayload, QbBridgeResult, QbAsyncResult } from "./types"

/**
 * Creates a Write Check in QuickBooks (async fire-and-poll).
 * Used when issuing a physical refund to a customer.
 */
export async function createCheckInQb(
    payload: QbCreateCheckPayload
): Promise<QbBridgeResult<QbAsyncResult>> {
    if (DRY_RUN) {
        console.log(
            `[QB DRY RUN] Would create Write Check for customer ${payload.customerId}` +
            ` — amount $${payload.amount.toFixed(2)}`
        )
        return {
            success: true,
            dryRun: true,
            data: { operationId: "DRY_RUN", txnId: "DRY_RUN_CHECK_TXNID", refNumber: "DRY_RUN_REF" },
        }
    }

    try {
        const body = {
            AccountRef:      { ListID: payload.bankAccountListId },
            PayeeEntityRef:  { ListID: payload.customerId },
            TxnDate:         payload.date,
            RefNumber:       payload.refNumber,
            Memo:            payload.memo,
            ExpenseLineAdd: [
                {
                    AccountRef: { FullName: payload.expenseAccountName ?? "Accounts Receivable" },
                    Amount:     payload.amount.toFixed(2),
                    Memo:       payload.memo,
                },
            ],
        }
        const data = await bridgeFetch("POST", "/api/checks", body)
        const operationId = data?.operationId
        if (!operationId) throw new Error("Bridge did not return an operationId for Write Check")
        return { success: true, data: { operationId } }
    } catch (err: any) {
        return { success: false, error: err.message }
    }
}

/**
 * Voids an existing Write Check in QuickBooks.
 */
export async function voidCheckInQb(
    checkTxnId: string
): Promise<QbBridgeResult<QbAsyncResult>> {
    if (DRY_RUN) {
        return {
            success: true,
            dryRun: true,
            data: { operationId: "DRY_RUN", txnId: checkTxnId },
        }
    }

    try {
        const data = await bridgeFetch("POST", `/api/checks/${checkTxnId}/void`, {})
        const operationId = data?.operationId
        if (!operationId) throw new Error("Bridge did not return an operationId for void-check")
        return { success: true, data: { operationId, txnId: checkTxnId } }
    } catch (err: any) {
        return { success: false, error: err.message }
    }
}

/**
 * Polls for the result of a previously queued Write Check operation.
 */
export async function pollCheckResult(
    operationId: string,
    log: (msg: string) => void = console.log
): Promise<QbAsyncResult> {
    return pollOperationResult(operationId, log)
}

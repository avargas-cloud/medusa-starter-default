import { DRY_RUN, bridgeFetch } from "./core"
import { QbReceivePaymentPayload, QbBridgeResult, QbAsyncResult } from "./types"

/**
 * Records a payment receipt in QuickBooks (async).
 * With autoApply: false, creates an unapplied credit that can be applied to the Invoice later.
 */
export async function receivePaymentInQb(
    payload: QbReceivePaymentPayload
): Promise<QbBridgeResult<QbAsyncResult>> {
    if (DRY_RUN) {
        console.log(`[QB DRY RUN] Would record payment in QB: $${payload.amount} from ${payload.customerId}`)
        return { success: true, dryRun: true, data: { operationId: "DRY_RUN", txnId: "DRY_RUN_PAYMENT_TXNID", refNumber: "DRY_RUN_REF" } }
    }

    try {
        const body = {
            autoApply: false, // default: keep as open credit for e-commerce flow
            ...payload,
        }
        const data = await bridgeFetch("POST", "/api/payments", body)
        const operationId = data?.operationId
        if (!operationId) throw new Error("Bridge did not return an operationId for Payment")
        return { success: true, data: { operationId } }
    } catch (err: any) {
        return { success: false, error: err.message }
    }
}

/**
 * Applies a payment credit to an invoice (async — closes the accounting loop).
 * Called after createInvoiceInQb(), using the payment TxnID from receivePaymentInQb().
 */
export async function applyPaymentToInvoiceInQb(payload: {
    customerId: string
    amount: number | string
    invoiceId: string
    creditTxnId: string
}): Promise<QbBridgeResult<QbAsyncResult>> {
    if (DRY_RUN) {
        console.log(`[QB DRY RUN] Would apply payment ${payload.creditTxnId} to invoice ${payload.invoiceId}`)
        return { success: true, dryRun: true, data: { operationId: "DRY_RUN" } }
    }

    try {
        const data = await bridgeFetch("POST", `/api/payments`, {
            customerId: payload.customerId,
            invoiceId: payload.invoiceId,
            amount: payload.amount,
            creditTxnId: payload.creditTxnId
        })
        const operationId = data?.operationId
        if (!operationId) throw new Error("Bridge did not return an operationId for apply-payment")
        return { success: true, data: { operationId } }
    } catch (err: any) {
        return { success: false, error: err.message }
    }
}

/**
 * Voids a payment entirely in QuickBooks.
 */
export async function voidPaymentInQb(paymentTxnId: string): Promise<QbBridgeResult<QbAsyncResult>> {
    if (DRY_RUN) {
        console.log(`[QB DRY RUN] Would void payment ${paymentTxnId}`)
        return { success: true, dryRun: true, data: { operationId: "DRY_RUN", txnId: paymentTxnId } }
    }

    try {
        const data = await bridgeFetch("POST", `/api/payments/${paymentTxnId}/void`, {})
        const operationId = data?.operationId
        if (!operationId) throw new Error("Bridge did not return an operationId for void-payment")
        return { success: true, data: { operationId, txnId: paymentTxnId } }
    } catch (err: any) {
        return { success: false, error: err.message }
    }
}

/**
 * Unapplies a payment from a specific invoice in QuickBooks.
 * This instructs QBXML to send a ReceivePaymentMod setting the PaymentAmount for the target invoice to 0.00.
 * Requires the EditSequence to be supplied (fetch via query first).
 */
export async function unapplyPaymentFromInvoiceInQb(payload: {
    creditTxnId: string
    invoiceId: string
    editSequence: string
}): Promise<QbBridgeResult<QbAsyncResult>> {
    if (DRY_RUN) {
        console.log(`[QB DRY RUN] Would unapply payment ${payload.creditTxnId} from invoice ${payload.invoiceId} (Seq: ${payload.editSequence})`)
        return { success: true, dryRun: true, data: { operationId: "DRY_RUN" } }
    }

    try {
        const data = await bridgeFetch("POST", `/api/payments/${payload.creditTxnId}/unapply`, {
            invoiceId: payload.invoiceId,
            EditSequence: payload.editSequence
        })
        const operationId = data?.operationId
        if (!operationId) throw new Error("Bridge did not return an operationId for unapply-payment")
        return { success: true, data: { operationId } }
    } catch (err: any) {
        return { success: false, error: err.message }
    }
}

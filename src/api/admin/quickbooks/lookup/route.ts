import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { bridgeFetch, POLL_INTERVAL_MS, MAX_POLL_ATTEMPTS } from "../../../../lib/quickbooks/client/core"

type QbDocType = 'Estimate' | 'SalesOrder' | 'Invoice' | 'SalesReceipt' | 'CreditMemo' | 'Check' | 'ReceivePayment'

interface DocTypeConfig {
    queryElement: string
    retElement:   string
    rsElement:    string
}

const DOC_TYPE_CONFIG: Record<QbDocType, DocTypeConfig> = {
    Estimate:       { queryElement: 'EstimateQueryRq',       retElement: 'EstimateRet',       rsElement: 'EstimateQueryRs' },
    SalesOrder:     { queryElement: 'SalesOrderQueryRq',     retElement: 'SalesOrderRet',     rsElement: 'SalesOrderQueryRs' },
    Invoice:        { queryElement: 'InvoiceQueryRq',        retElement: 'InvoiceRet',        rsElement: 'InvoiceQueryRs' },
    SalesReceipt:   { queryElement: 'SalesReceiptQueryRq',   retElement: 'SalesReceiptRet',   rsElement: 'SalesReceiptQueryRs' },
    CreditMemo:     { queryElement: 'CreditMemoQueryRq',     retElement: 'CreditMemoRet',     rsElement: 'CreditMemoQueryRs' },
    Check:          { queryElement: 'CheckQueryRq',          retElement: 'CheckRet',          rsElement: 'CheckQueryRs' },
    ReceivePayment: { queryElement: 'ReceivePaymentQueryRq', retElement: 'ReceivePaymentRet', rsElement: 'ReceivePaymentQueryRs' },
}

const VALID_DOC_TYPES = Object.keys(DOC_TYPE_CONFIG) as QbDocType[]

/**
 * POST /admin/quickbooks/lookup
 *
 * Queries QB Bridge for a document's TxnID by doc type and ref number.
 *
 * Body: { docType: QbDocType, refNumber: string }
 * Returns: { success, txnId, refNumber, docType, customerName?, amount? }
 */
export async function POST(req: MedusaRequest, res: MedusaResponse): Promise<void> {
    const { docType, refNumber } = (req.body ?? {}) as { docType?: string; refNumber?: string }

    if (!docType || !VALID_DOC_TYPES.includes(docType as QbDocType)) {
        res.status(400).json({ error: `docType must be one of: ${VALID_DOC_TYPES.join(', ')}` })
        return
    }
    if (!refNumber?.trim()) {
        res.status(400).json({ error: 'refNumber is required' })
        return
    }

    const cfg = DOC_TYPE_CONFIG[docType as QbDocType]
    const ref = refNumber.trim()

    const qbxml = [
        `<?xml version="1.0" encoding="utf-8"?>`,
        `<?qbxml version="10.0"?>`,
        `<QBXML><QBXMLMsgsRq onError="stopOnError">`,
        `<${cfg.queryElement} requestID="1">`,
        `<RefNumber>${ref}</RefNumber>`,
        `</${cfg.queryElement}>`,
        `</QBXMLMsgsRq></QBXML>`,
    ].join('')

    try {
        const enqueueRes = await bridgeFetch('POST', '/api/sync/direct-query', { qbxml })
        const operationId: string = enqueueRes?.operationId || enqueueRes?.operation_id
        if (!operationId) throw new Error('Bridge did not return operationId')

        let rawResult: Record<string, unknown> | null = null

        for (let attempt = 1; attempt <= MAX_POLL_ATTEMPTS; attempt++) {
            await new Promise(r => setTimeout(r, POLL_INTERVAL_MS))
            const statusRes = await bridgeFetch('GET', `/api/sync/status/${operationId}`)
            const op = statusRes?.operation
            if (!op) continue
            if (op.status === 'completed') {
                rawResult = op.result as Record<string, unknown>
                break
            }
            if (op.status === 'failed') {
                throw new Error(`QB query failed: ${op.error || 'Unknown error'}`)
            }
        }

        if (!rawResult) {
            throw new Error('QB query timed out — QuickBooks Desktop may be offline or QBWC not connected')
        }

        // Unwrap the nested QB response envelope
        const qbMsgs: Record<string, unknown> =
            (rawResult as any)?.QBXML?.QBXMLMsgsRs ??
            (rawResult as any)?.QBXMLMsgsRs ??
            rawResult

        const retRaw: unknown =
            (qbMsgs as any)?.[cfg.rsElement]?.[cfg.retElement] ??
            (rawResult as any)?.[cfg.rsElement]?.[cfg.retElement] ??
            (rawResult as any)?.[cfg.retElement]

        if (!retRaw) {
            res.status(404).json({ error: `${docType} #${ref} not found in QuickBooks` })
            return
        }

        const doc: Record<string, any> = Array.isArray(retRaw) ? retRaw[0] : retRaw
        const txnId: string = doc.TxnID || ''

        if (!txnId) {
            res.status(404).json({ error: `${docType} #${ref} returned no TxnID from QB` })
            return
        }

        // Extract optional enrichment fields (varies by doc type)
        const customerName: string =
            doc.CustomerRef?.FullName ||
            doc.PayeeEntityRef?.FullName ||
            doc.EntityRef?.FullName ||
            ''

        const amount: number =
            parseFloat(doc.Subtotal || doc.TotalAmount || doc.Amount || doc.TxnAmount || '0') || 0

        const editSequence: string = doc.EditSequence || ''

        res.json({
            success: true,
            txnId,
            editSequence: editSequence || null,
            refNumber: ref,
            docType,
            customerName: customerName || null,
            amount: amount || null,
        })

    } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : 'Failed to look up TXIND'
        console.error(`[QB Lookup ${docType} #${refNumber}] Error:`, error)
        res.status(500).json({ error: msg })
    }
}

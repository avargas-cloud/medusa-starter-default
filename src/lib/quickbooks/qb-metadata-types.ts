/**
 * qb-metadata-types.ts
 *
 * Canonical TypeScript types for all QuickBooks-related metadata stored on
 * Medusa Orders and Draft Orders.
 *
 * Schema:
 *   qb_estimate    — QB Estimate document (from Draft Order sync)
 *   qb_sales_order — QB Sales Order document
 *   qb_invoices    — QB Invoice documents (array, one per fulfillment)
 *   qb_payments    — QB Payment documents (array, one per payment / split)
 *   qb_sync_status — Overall sync state (for badges / filtering)
 *   qb_list_id     — QB Customer ListID (flat string, unchanged)
 *   qb_synced_at   — ISO timestamp of last sync (flat string, unchanged)
 */

// ─── Document shapes ──────────────────────────────────────────────────────────

export interface QbEstimateMeta {
    ref_number:   string           // e.g. "EST-0042" or the QB auto-ref
    txn_id:       string           // QB TxnID returned by QBWC
    operation_id: string | null    // bridge operation ID (null once confirmed)
    synced_at:    string           // ISO 8601 timestamp
}

export interface QbSalesOrderMeta {
    ref_number:   string
    txn_id:       string
    operation_id: string | null
    synced_at:    string
}

export interface QbInvoiceMeta {
    ref_number:     string
    txn_id:         string
    operation_id:   string | null
    fulfillment_id: string | null    // Medusa fulfillment ID (null for legacy)
    invoice_id?:    string | null    // POS Invoice ID for explicit mapping
    synced_at:      string
}

export interface QbPaymentMeta {
    ref_number:   string | null
    txn_id:       string
    operation_id: string | null
    amount:        number           // cents
    method:        string           // e.g. "cash", "check", "Credit Card"
    synced_at:     string
}

/** Sentinel value for orders that bypass the SO → Invoice flow (paid immediately). */
export const QB_DIRECT_SALES = "Direct Sales" as const

export type QbSyncStatus =
    | "pending"                // queued but QBWC hasn't processed yet
    | "direct_invoice"         // < 1h, paid immediately (no SO created)
    | "sales_order"            // SO created by cron / subscriber
    | "estimate_conversion"    // came from a Draft Order estimate
    | null                     // not yet synced

/** Full QB metadata shape on a Medusa order */
export interface QbOrderMetadata {
    qb_estimate:    QbEstimateMeta    | typeof QB_DIRECT_SALES | null
    qb_sales_order: QbSalesOrderMeta  | typeof QB_DIRECT_SALES | null
    qb_invoices:    QbInvoiceMeta[]   | null
    qb_payments:    QbPaymentMeta[]   | null
    qb_sync_status: QbSyncStatus
    // Flat fields kept unchanged:
    qb_list_id:     string | null
    qb_synced_at:   string | null
}

// ─── Backward-compat reader helpers ──────────────────────────────────────────
//
// During / after migration old orders may still have flat fields.
// Always read via these helpers so code works in both cases.

/** Read the QB Estimate TxnID from new or old metadata shape. */
export function getEstimateTxnId(meta: Record<string, any> | null | undefined): string | undefined {
    if (!meta) return undefined
    // New shape
    if (meta.qb_estimate && typeof meta.qb_estimate === "object" && meta.qb_estimate.txn_id) {
        return meta.qb_estimate.txn_id as string
    }
    // Old flat field
    return (meta.qb_estimate_txn_id as string | undefined) ?? undefined
}

/** Read the QB Estimate RefNumber from new or old metadata shape. */
export function getEstimateRef(meta: Record<string, any> | null | undefined): string | undefined {
    if (!meta) return undefined
    if (meta.qb_estimate && typeof meta.qb_estimate === "object" && meta.qb_estimate.ref_number) {
        return meta.qb_estimate.ref_number as string
    }
    return (meta.qb_estimate_ref as string | undefined) ?? undefined
}

/** Read the QB Sales Order TxnID from new or old metadata shape. */
export function getSoTxnId(meta: Record<string, any> | null | undefined): string | undefined {
    if (!meta) return undefined
    if (meta.qb_sales_order && typeof meta.qb_sales_order === "object" && meta.qb_sales_order.txn_id) {
        return meta.qb_sales_order.txn_id as string
    }
    return (meta.qb_sales_order_txn_id as string | undefined) ?? undefined
}

/** Read the QB Sales Order RefNumber from new or old metadata shape. */
export function getSoRef(meta: Record<string, any> | null | undefined): string | undefined {
    if (!meta) return undefined
    if (meta.qb_sales_order && typeof meta.qb_sales_order === "object" && meta.qb_sales_order.ref_number) {
        return meta.qb_sales_order.ref_number as string
    }
    return (meta.qb_sales_order_ref as string | undefined) ?? undefined
}

/** Read the QB Sales Order OperationID from new or old metadata shape. */
export function getSoOperationId(meta: Record<string, any> | null | undefined): string | undefined {
    if (!meta) return undefined
    if (meta.qb_sales_order && typeof meta.qb_sales_order === "object" && meta.qb_sales_order.operation_id) {
        return meta.qb_sales_order.operation_id as string
    }
    return (meta.qb_sales_order_operation_id as string | undefined) ?? undefined
}

/** Read the most recent QB Invoice TxnID (last entry in the array, or old flat field). */
export function getLatestInvoiceTxnId(meta: Record<string, any> | null | undefined): string | undefined {
    if (!meta) return undefined
    const arr = meta.qb_invoices
    if (Array.isArray(arr) && arr.length > 0) {
        return arr[arr.length - 1].txn_id as string
    }
    return (meta.qb_invoice_txn_id as string | undefined) ?? undefined
}

/** Read the most recent QB Invoice RefNumber. */
export function getLatestInvoiceRef(meta: Record<string, any> | null | undefined): string | undefined {
    if (!meta) return undefined
    const arr = meta.qb_invoices
    if (Array.isArray(arr) && arr.length > 0) {
        return arr[arr.length - 1].ref_number as string
    }
    return (meta.qb_invoice_ref as string | undefined) ?? undefined
}

/** Read the most recent QB Payment TxnID. */
export function getLatestPaymentTxnId(meta: Record<string, any> | null | undefined): string | undefined {
    if (!meta) return undefined
    const arr = meta.qb_payments
    if (Array.isArray(arr) && arr.length > 0) {
        return arr[arr.length - 1].txn_id as string
    }
    return (meta.qb_payment_txn_id as string | undefined) ?? undefined
}

/** Read the most recent QB Payment RefNumber. */
export function getLatestPaymentRef(meta: Record<string, any> | null | undefined): string | undefined {
    if (!meta) return undefined
    const arr = meta.qb_payments
    if (Array.isArray(arr) && arr.length > 0) {
        return arr[arr.length - 1].ref_number as string | undefined
    }
    return (meta.qb_payment_ref as string | undefined) ?? undefined
}

// ─── Metadata patch builders ──────────────────────────────────────────────────
//
// Return partial metadata objects to spread into updateOrders() calls.
// These always write the NEW shape. Old flat fields are NOT included.

/** Build the metadata patch for an Estimate sync result. */
export function buildEstimatePatch(
    existingMeta: Record<string, any>,
    opts: { txnId: string; refNumber: string | null; operationId: string | null }
): Record<string, any> {
    const patch: QbEstimateMeta = {
        txn_id:       opts.txnId,
        ref_number:   opts.refNumber ?? opts.txnId,
        operation_id: opts.operationId,
        synced_at:    new Date().toISOString(),
    }
    return {
        ...existingMeta,
        qb_estimate:   patch,
        qb_synced_at:  patch.synced_at,
    }
}

/** Build the metadata patch for a Sales Order sync result. */
export function buildSaleOrderPatch(
    existingMeta: Record<string, any>,
    opts: {
        txnId: string | null
        refNumber: string | null
        operationId: string | null
        customerId?: string | null
        syncStatus?: QbSyncStatus
    }
): Record<string, any> {
    const now = new Date().toISOString()
    const patch: QbSalesOrderMeta = {
        txn_id:       opts.txnId ?? "",
        ref_number:   opts.refNumber ?? opts.txnId ?? "",
        operation_id: opts.operationId,
        synced_at:    now,
    }
    return {
        ...existingMeta,
        qb_sales_order:  patch,
        qb_sync_status:  opts.syncStatus ?? existingMeta.qb_sync_status ?? "sales_order",
        ...(opts.customerId !== undefined ? { qb_list_id: opts.customerId } : {}),
        qb_synced_at:    now,
    }
}

/** Build the metadata patch for an Invoice sync result (appends to array). */
export function buildInvoicePatch(
    existingMeta: Record<string, any>,
    opts: {
        txnId: string | null
        refNumber: string | null
        operationId: string | null
        fulfillmentId?: string | null
        invoiceId?: string | null
    }
): Record<string, any> {
    const now = new Date().toISOString()
    const existing: QbInvoiceMeta[] = Array.isArray(existingMeta.qb_invoices)
        ? existingMeta.qb_invoices
        : []
    const newEntry: QbInvoiceMeta = {
        txn_id:         opts.txnId ?? "",
        ref_number:     opts.refNumber ?? opts.txnId ?? "",
        operation_id:   opts.operationId,
        fulfillment_id: opts.fulfillmentId ?? null,
        invoice_id:     opts.invoiceId ?? null,
        synced_at:      now,
    }
    return {
        ...existingMeta,
        qb_invoices:  [...existing, newEntry],
        qb_synced_at: now,
    }
}

/** Build the metadata patch for a Payment sync result (appends to array). */
export function buildPaymentPatch(
    existingMeta: Record<string, any>,
    opts: {
        txnId: string | null
        refNumber: string | null
        operationId: string | null
        amount: number
        method: string
    }
): Record<string, any> {
    const now = new Date().toISOString()
    const existing: QbPaymentMeta[] = Array.isArray(existingMeta.qb_payments)
        ? existingMeta.qb_payments
        : []
    const newEntry: QbPaymentMeta = {
        txn_id:       opts.txnId ?? "",
        ref_number:   opts.refNumber,
        operation_id: opts.operationId,
        amount:        opts.amount,
        method:        opts.method,
        synced_at:     now,
    }
    return {
        ...existingMeta,
        qb_payments:  [...existing, newEntry],
        qb_synced_at: now,
    }
}

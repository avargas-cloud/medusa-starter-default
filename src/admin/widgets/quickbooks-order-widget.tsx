import { defineWidgetConfig } from "@medusajs/admin-sdk"
import { DetailWidgetProps } from "@medusajs/framework/types"
import { Container, Heading, Badge, Text, Label, Button, toast } from "@medusajs/ui"
import { useState, useEffect, useRef, useCallback } from "react"

/**
 * QuickBooks Order Widget  (zone: order.details.before)
 *
 * Shows QB sync status for a confirmed Order.
 * Metadata keys:
 *   qb_sales_order_txn_id   — QB Sales Order TxnID
 *   qb_sales_order_ref      — QB Sales Order number (e.g. "1042")
 *   qb_payment_txn_id       — QB Payment TxnID (set after payment captured)
 *   qb_invoice_txn_id       — QB Invoice TxnID (set after fulfillment)
 *   qb_estimate_txn_id      — QB Estimate (only present if came from Draft Order)
 *   qb_synced_at            — ISO timestamp of last QB sync
 */

// ─── Sub-components ──────────────────────────────────────────────────────────

const QBField = ({
    label,
    value,
    mono = true,
}: {
    label: string
    value: string | null | undefined
    mono?: boolean
}) => (
    <div className="flex flex-col gap-1">
        <Label className="text-[10px] text-ui-fg-muted uppercase tracking-widest font-medium">
            {label}
        </Label>
        <div
            className={`px-3 py-2 rounded-md bg-ui-bg-subtle border border-ui-border-base text-sm min-h-[36px] flex items-center ${mono ? "font-mono" : ""
                }`}
        >
            {value ? (
                <span className="text-ui-fg-base truncate">{value}</span>
            ) : (
                <span className="text-ui-fg-muted italic text-xs">Not synced</span>
            )}
        </div>
    </div>
)

const StatusDot = ({ synced }: { synced: boolean }) => (
    <span
        className={`inline-block w-2 h-2 rounded-full ${synced ? "bg-ui-tag-green-icon" : "bg-ui-tag-orange-icon"
            }`}
    />
)

// ─── Main Widget ─────────────────────────────────────────────────────────────

const QuickBooksOrderWidget = ({ data }: DetailWidgetProps<any>) => {
    const [loading, setLoading] = useState(false)
    const [refreshing, setRefreshing] = useState(false)
    const [localMeta, setLocalMeta] = useState<Record<string, any>>(data?.metadata ?? {})
    const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

    // Removed early return so widget is always visible even if canceled/archived
    const soTxnId: string | null = localMeta.qb_sales_order_txn_id ?? null
    const soRef: string | null = localMeta.qb_sales_order_ref ?? null
    const paymentTxnId: string | null = localMeta.qb_payment_txn_id ?? null
    const invoiceTxnId: string | null = localMeta.qb_invoice_txn_id ?? null
    const estimateTxnId: string | null = localMeta.qb_estimate_txn_id ?? null
    const operationId: string | null = localMeta.qb_sales_order_operation_id ?? null
    const syncedAt: string | null = localMeta.qb_synced_at ?? null

    const soSynced = !!soTxnId
    const fromDraft = !!estimateTxnId
    // Pending = operation was queued but QBWC hasn't processed it yet
    const isPending = !soSynced && !!operationId

    const fetchMeta = useCallback(async () => {
        try {
            const resp = await fetch(`/admin/orders/${data.id}?fields=metadata`, {
                credentials: "include",
            })
            if (!resp.ok) return
            const json = await resp.json()
            const meta = json?.order?.metadata ?? {}
            if (meta.qb_sales_order_txn_id) {
                setLocalMeta(meta)
                // Stop polling once txnId is present
                if (pollRef.current) clearInterval(pollRef.current)
            }
        } catch {
            // silently ignore refresh errors
        }
    }, [data.id])

    const handleRefresh = async () => {
        setRefreshing(true)
        try {
            const resp = await fetch(`/admin/orders/${data.id}?fields=metadata`, {
                credentials: "include",
            })
            if (resp.ok) {
                const json = await resp.json()
                setLocalMeta(json?.order?.metadata ?? localMeta)
            }
        } finally {
            setRefreshing(false)
        }
    }

    // Auto-poll every 8s whenever the SO is not yet synced (no txnId).
    // This covers the case where the page loads before the subscriber saves the operationId.
    // Polling stops as soon as qb_sales_order_txn_id appears in metadata.
    useEffect(() => {
        if (!soSynced) {
            pollRef.current = setInterval(fetchMeta, 8_000)
        }
        return () => {
            if (pollRef.current) clearInterval(pollRef.current)
        }
    }, [soSynced, fetchMeta])

    const handleSync = async (force = false) => {
        setLoading(true)
        try {
            const resp = await fetch("/admin/quickbooks/order", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                credentials: "include",
                body: JSON.stringify({ orderId: data.id, force }),
            })

            const json = await resp.json()

            if (!resp.ok) {
                toast.error("QuickBooks Sync Failed", { description: json.error || "Unknown error" })
                return
            }

            if (json.alreadySynced && !force) {
                toast.info("Already Synced", {
                    description: `QB Sales Order #${json.qbSoRef || json.qbSoTxnId} already exists.`,
                })
                return
            }

            // Optimistically update local metadata display
            setLocalMeta((prev) => ({
                ...prev,
                qb_sales_order_txn_id: json.qbSoTxnId ?? prev.qb_sales_order_txn_id,
                qb_sales_order_ref: json.qbSoRef ?? prev.qb_sales_order_ref,
                qb_synced_at: new Date().toISOString(),
            }))

            toast.success(soSynced ? "Re-sync Queued" : "Sales Order Created", {
                description: json.message,
            })
        } catch (err: any) {
            toast.error("Network Error", { description: err.message })
        } finally {
            setLoading(false)
        }
    }

    return (
        <Container className="p-0 overflow-hidden">
            {/* ── Header ─────────────────────────────────────────────────── */}
            <div className="flex items-center gap-2 px-6 py-3 border-b border-ui-border-base">
                <Heading level="h2">QuickBooks</Heading>
                <Badge color="blue" size="small">QB Desktop</Badge>
                <div className="flex items-center gap-1.5">
                    <StatusDot synced={soSynced} />
                    {soSynced ? (
                        <Badge color="green" size="small">Sales Order Synced</Badge>
                    ) : isPending ? (
                        <Badge color="orange" size="small">⏳ Pending Sync</Badge>
                    ) : (
                        <Badge color="orange" size="small">Pending Sync</Badge>
                    )}
                </div>
                {fromDraft && (
                    <Badge color="purple" size="small">From Draft Order</Badge>
                )}
                <div className="ml-auto flex items-center gap-2">
                    {isPending && (
                        <span className="text-xs text-ui-fg-muted italic">Auto-refreshing…</span>
                    )}
                    <Button
                        size="small"
                        variant="transparent"
                        isLoading={refreshing}
                        onClick={handleRefresh}
                        title="Refresh QB status"
                    >
                        ↻
                    </Button>
                    {syncedAt && (
                        <span className="text-xs text-ui-fg-muted">
                            Synced{" "}
                            {new Date(syncedAt).toLocaleString("en-US", {
                                month: "short",
                                day: "numeric",
                                year: "numeric",
                                hour: "2-digit",
                                minute: "2-digit",
                            })}
                        </span>
                    )}
                </div>
            </div>

            {/* ── Fields grid ────────────────────────────────────────────── */}
            <div className="px-6 py-4 space-y-4">
                <div className="grid grid-cols-3 gap-4">
                    <QBField label="Sales Order Number" value={soRef} />
                    <QBField label="Sales Order TxnID" value={soTxnId} />
                    <QBField label="Payment TxnID" value={paymentTxnId} />
                </div>
                {invoiceTxnId && (
                    <div className="grid grid-cols-3 gap-4">
                        <QBField label="Invoice TxnID" value={invoiceTxnId} />
                    </div>
                )}
            </div>

            {/* ── Context note (Draft-derived orders) ────────────────────── */}
            {fromDraft && (
                <div className="mx-6 mb-3 px-3 py-2 bg-ui-bg-subtle rounded-md border border-ui-border-base">
                    <Text size="xsmall" className="text-ui-fg-muted">
                        {soSynced
                            ? `QB Estimate was converted to Sales Order when this order was confirmed.`
                            : `This order came from a Draft Order. Syncing will convert the QB Estimate (${estimateTxnId}) to a Sales Order.`}
                    </Text>
                </div>
            )}

            {/* ── Sync button ──────────────────────────────────────────────── */}
            <div className="px-6 pb-4 flex gap-2">
                {!soSynced && (
                    <Button
                        size="small"
                        variant="primary"
                        isLoading={loading}
                        onClick={() => handleSync(false)}
                    >
                        {fromDraft ? "Convert Estimate → Sales Order" : "Create Sales Order in QB"}
                    </Button>
                )}
                {soSynced && (
                    <Button
                        size="small"
                        variant="secondary"
                        isLoading={loading}
                        onClick={() => handleSync(true)}
                    >
                        Re-sync Sales Order
                    </Button>
                )}
            </div>
        </Container>
    )
}

export const config = defineWidgetConfig({
    zone: "order.details.before",
})

export default QuickBooksOrderWidget

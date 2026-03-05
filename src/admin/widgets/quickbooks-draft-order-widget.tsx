import { defineWidgetConfig } from "@medusajs/admin-sdk"
import { DetailWidgetProps } from "@medusajs/framework/types"
import { Container, Heading, Badge, Label, Text } from "@medusajs/ui"

/**
 * QuickBooks Order Widget  (zone: order.details.before)
 *
 * Displays QB sync info on the native Order Detail page.
 *
 * Metadata keys read:
 *   qb_sales_order_ref        — QB Sales Order reference number (e.g. SO-1042)
 *   qb_sales_order_txn_id     — QB Sales Order internal TxnID
 *   qb_estimate_ref           — QB Estimate linked to this order (if converted from draft)
 *   qb_estimate_txn_id        — QB Estimate TxnID (presence indicates order came from draft)
 *   qb_synced_at              — ISO timestamp of last QB sync
 */

// Small read-only field
const QBField = ({ label, value, mono = true }: { label: string; value: string | null; mono?: boolean }) => (
    <div>
        <Label className="mb-1 block text-sm text-ui-fg-subtle">{label}</Label>
        <div className={`px-3 py-2 rounded-md bg-ui-bg-subtle border border-ui-border-base text-sm min-h-[36px] ${mono ? "font-mono" : ""}`}>
            {value
                ? <span className="text-ui-fg-base">{value}</span>
                : <span className="text-ui-fg-muted italic">—</span>
            }
        </div>
    </div>
)

const QuickBooksOrderWidget = ({ data }: DetailWidgetProps<any>) => {
    const status: string = data?.status ?? ""

    // Skip terminal states (nothing useful to show)
    if (["canceled", "archived"].includes(status)) return null

    const meta = data?.metadata ?? {}

    // Sales Order (set by qb-order-subscriber after order.placed)
    const soRef: string | null = meta.qb_sales_order_ref ?? null
    const soTxnId: string | null = meta.qb_sales_order_txn_id ?? null
    const soSynced = !!soTxnId

    // Estimate (only present if order was converted from a Draft Order)
    const estimateRef: string | null = meta.qb_estimate_ref ?? null
    const estimateTxnId: string | null = meta.qb_estimate_txn_id ?? null
    const fromDraftOrder = !!estimateTxnId  // if estimate txn exists, this order came from a Draft

    const syncedAt: string | null = meta.qb_synced_at ?? null

    return (
        <Container className="p-0 overflow-hidden">
            {/* Header */}
            <div className="flex items-center gap-2 px-6 py-4 border-b border-ui-border-base">
                <Heading level="h2">QuickBooks</Heading>
                <Badge color="blue" size="small">QB Desktop</Badge>
                {soSynced && <Badge color="green" size="small">✓ Sales Order Synced</Badge>}
                {!soSynced && <Badge color="orange" size="small">Pending Sync</Badge>}
            </div>

            <div className="px-6 py-4 space-y-4">

                {/* ── Sales Order (primary) ───────────────────────────────── */}
                <div>
                    <Text size="xsmall" weight="plus" className="text-ui-fg-muted uppercase tracking-wide mb-2">
                        Sales Order
                    </Text>
                    <div className="space-y-3">
                        <QBField label="Sales Order Number" value={soRef} />
                        <QBField label="QB TxnID" value={soTxnId} />
                    </div>
                </div>

                {/* ── Linked Estimate (only if from draft order) ─────────── */}
                <div className="pt-2 border-t border-ui-border-base">
                    <div className="flex items-center gap-2 mb-2">
                        <Text size="xsmall" weight="plus" className="text-ui-fg-muted uppercase tracking-wide">
                            Linked Estimate
                        </Text>
                        {fromDraftOrder
                            ? <Badge color="purple" size="small">From Draft Order</Badge>
                            : <Badge color="grey" size="small">Direct Order</Badge>
                        }
                    </div>
                    {fromDraftOrder ? (
                        <div className="space-y-3">
                            <QBField label="Estimate Number" value={estimateRef} />
                            <QBField label="Estimate TxnID" value={estimateTxnId} />
                        </div>
                    ) : (
                        <div className="px-3 py-2 rounded-md bg-ui-bg-subtle border border-ui-border-base">
                            <Text size="xsmall" className="text-ui-fg-muted italic">
                                This order was not converted from a Draft Order — no linked QB Estimate.
                            </Text>
                        </div>
                    )}
                </div>

                {/* ── Last sync timestamp ─────────────────────────────────── */}
                {syncedAt && (
                    <Text size="xsmall" className="text-ui-fg-muted pt-1">
                        Last synced: {new Date(syncedAt).toLocaleString("en-US", {
                            month: "short", day: "numeric", year: "numeric",
                            hour: "2-digit", minute: "2-digit"
                        })}
                    </Text>
                )}
            </div>
        </Container>
    )
}

export const config = defineWidgetConfig({
    zone: "order.details.before",
})

export default QuickBooksOrderWidget

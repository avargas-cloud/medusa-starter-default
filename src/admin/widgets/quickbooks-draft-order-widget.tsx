import { defineWidgetConfig } from "@medusajs/admin-sdk"
import { DetailWidgetProps } from "@medusajs/framework/types"
import { Container, Heading, Badge, Label, Text } from "@medusajs/ui"

/**
 * QuickBooks Order Widget  (zone: order.details.before)
 *
 * Displays QB sync info on the native Order Detail page.
 * Layout: single row with 3 columns — Linked Estimate | Sales Order Number | QB TxnID
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
        <Label className="mb-1 block text-xs text-ui-fg-subtle uppercase tracking-wide">{label}</Label>
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
            <div className="flex items-center gap-2 px-6 py-3 border-b border-ui-border-base">
                <Heading level="h2">QuickBooks</Heading>
                <Badge color="blue" size="small">QB Desktop</Badge>
                {soSynced && <Badge color="green" size="small">✓ Sales Order Synced</Badge>}
                {!soSynced && <Badge color="orange" size="small">Pending Sync</Badge>}
                {syncedAt && (
                    <span className="ml-auto text-xs text-ui-fg-muted">
                        Last synced: {new Date(syncedAt).toLocaleString("en-US", {
                            month: "short", day: "numeric", year: "numeric",
                            hour: "2-digit", minute: "2-digit"
                        })}
                    </span>
                )}
            </div>

            {/* ── Single-row 3-column layout ──────────────────────────────────── */}
            <div className="px-6 py-4">
                <div className="grid grid-cols-3 gap-4 items-start">

                    {/* Col 1: Linked Estimate */}
                    <div className="space-y-1">
                        <div className="flex items-center gap-2 mb-2">
                            <Text size="xsmall" weight="plus" className="text-ui-fg-muted uppercase tracking-wide">
                                Linked Estimate
                            </Text>
                            {fromDraftOrder
                                ? <Badge color="purple" size="small">Draft Order</Badge>
                                : <Badge color="grey" size="small">Direct Order</Badge>
                            }
                        </div>
                        {fromDraftOrder ? (
                            <QBField label="Estimate Number" value={estimateRef} />
                        ) : (
                            <div className="px-3 py-2 rounded-md bg-ui-bg-subtle border border-ui-border-base min-h-[36px] flex items-center">
                                <Text size="xsmall" className="text-ui-fg-muted italic">
                                    No linked QB Estimate
                                </Text>
                            </div>
                        )}
                    </div>

                    {/* Col 2: Sales Order Number */}
                    <div>
                        <QBField label="Sales Order Number" value={soRef} />
                    </div>

                    {/* Col 3: QB TxnID */}
                    <div>
                        <Text size="xsmall" weight="plus" className="text-ui-fg-muted uppercase tracking-wide mb-2 block">
                            &nbsp;
                        </Text>
                        <QBField label="QB TxnID" value={soTxnId} />
                    </div>

                </div>
            </div>
        </Container>
    )
}

export const config = defineWidgetConfig({
    zone: "order.details.before",
})

export default QuickBooksOrderWidget

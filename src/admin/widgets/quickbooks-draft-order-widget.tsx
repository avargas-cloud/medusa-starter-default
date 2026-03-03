import { defineWidgetConfig } from "@medusajs/admin-sdk"
import { DetailWidgetProps } from "@medusajs/framework/types"
import { Container, Heading, Badge, Input, Label } from "@medusajs/ui"

/**
 * QuickBooks Order Widget
 *
 * Shows QB Estimate fields on the order detail page (zone: order.details.before).
 * Reads from metadata: qb_estimate_ref, qb_estimate_txn_id
 *
 * NOTE: The "Save to QuickBooks" button is commented out below.
 * Orders auto-sync to QB when placed (via qb-order-subscriber).
 * The button code is preserved for debugging — do not delete.
 *
 * For DRAFT ORDER QB sync, use: /draft-orders-advanced/:id
 */

const QuickBooksDraftOrderWidget = ({ data }: DetailWidgetProps<any>) => {
    // DEBUG: state kept for future save-button re-enable
    // const [loading, setLoading] = useState(false)
    // const [localRef, setLocalRef] = useState<string | null>(null)
    // const [localTxnId, setLocalTxnId] = useState<string | null>(null)
    // const [syncError, setSyncError] = useState<string | null>(null)

    // Skip completed/canceled/archived orders
    const status: string = data?.status ?? ""
    if (["completed", "canceled", "archived", "returned"].includes(status)) return null

    const estimateRef = (data?.metadata?.qb_estimate_ref as string | null) ?? null
    const estimateTxnId = (data?.metadata?.qb_estimate_txn_id as string | null) ?? null
    const isSynced = !!estimateTxnId

    /* DEBUG: save handler — kept for manual re-sync testing
    const handleSync = async () => {
        setLoading(true)
        setSyncError(null)
        try {
            const resp = await fetch("/admin/quickbooks/draft-order", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                credentials: "include",
                body: JSON.stringify({ orderId: data.id }),
            })
            const json = await resp.json()
            if (json.success) {
                if (json.qbEstimateTxnId) {
                    setLocalTxnId(json.qbEstimateTxnId)
                    setLocalRef(json.qbEstimateRef ?? json.qbEstimateTxnId)
                }
                toast.success(json.message || "Saved to QuickBooks!")
            } else {
                setSyncError(json.error || "Failed to sync")
                toast.error(json.error || "Failed to sync")
            }
        } catch (err: any) {
            setSyncError(err.message || "Network error")
            toast.error(err.message || "Network error")
        } finally {
            setLoading(false)
        }
    }
    */

    return (
        <Container className="p-6">
            <div className="flex items-center gap-2 mb-5">
                <Heading level="h2">QuickBooks</Heading>
                <Badge color="blue" size="small">QB Desktop</Badge>
                {isSynced && <Badge color="green" size="small">✓ Synced</Badge>}
            </div>

            <div className="space-y-4">
                <div>
                    <Label htmlFor="qb-estimate-ref" className="mb-1 block text-ui-fg-subtle text-sm font-medium">
                        Estimate Number
                    </Label>
                    <Input
                        id="qb-estimate-ref"
                        value={estimateRef ?? ""}
                        placeholder="Not synced yet"
                        readOnly
                        className="font-mono bg-ui-bg-subtle cursor-default"
                    />
                </div>

                <div>
                    <Label htmlFor="qb-txn-id" className="mb-1 block text-ui-fg-subtle text-sm font-medium">
                        QB TxnID
                    </Label>
                    <Input
                        id="qb-txn-id"
                        value={estimateTxnId ?? ""}
                        placeholder="Not synced yet"
                        readOnly
                        className="font-mono bg-ui-bg-subtle cursor-default"
                    />
                </div>
            </div>

            {/* DEBUG: Save button — preserved for manual re-sync / debugging
            <Button
                onClick={handleSync}
                isLoading={loading}
                disabled={loading}
                variant={isSynced ? "secondary" : "primary"}
                size="small"
                className="mt-4"
            >
                {isSynced ? "Re-sync to QuickBooks" : "Save to QuickBooks"}
            </Button>
            */}
        </Container>
    )
}

export const config = defineWidgetConfig({
    zone: "order.details.before",
})

export default QuickBooksDraftOrderWidget

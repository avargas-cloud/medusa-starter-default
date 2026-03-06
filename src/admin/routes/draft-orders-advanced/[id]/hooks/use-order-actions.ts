import { useState } from "react"
import { useNavigate } from "react-router-dom"
import { toast } from "@medusajs/ui"
import { EstimateStatus, DraftOrderDetail } from "../types"

interface Deps {
    id: string | undefined
    order: DraftOrderDetail | null
    estimateStatus: EstimateStatus | ""
    setEstimateStatus: (s: EstimateStatus | "") => void
    patchOrder: (body: Record<string, any>) => Promise<any>
}

/** Owns convert, delete, status change, QB sync, and metadata key management. */
export const useOrderActions = ({ id, order, estimateStatus, setEstimateStatus, patchOrder }: Deps) => {
    const navigate = useNavigate()
    const [converting, setConverting] = useState(false)
    const [statusSaving, setStatusSaving] = useState(false)
    const [syncing, setSyncing] = useState(false)
    const [localRef, setLocalRef] = useState<string | null>(null)
    const [localTxnId, setLocalTxnId] = useState<string | null>(null)
    const [syncError, setSyncError] = useState<string | null>(null)
    const [metadataForm, setMetadataForm] = useState<Record<string, string>>({})
    const [metaNewKey, setMetaNewKey] = useState("")
    const [metaNewVal, setMetaNewVal] = useState("")

    const handleConvert = async () => {
        const toastId = toast.loading("Converting to order… (Items with 0 stock will be accepted as backorders)")
        setConverting(true)
        try {
            const r = await fetch(`/admin/draft-orders/${id}/convert-force`, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" } })
            const j = await r.json()
            if (!r.ok) throw new Error(j.message || `HTTP ${r.status}: ${r.statusText}`)
            const orderId = j.order?.id ?? id
            toast.dismiss(toastId)
            toast.success(j.backorder_items_enabled ? "Converted to order! Some items are on backorder." : "Converted to order! Redirecting…")
            navigate(`/orders/${orderId}`)
        } catch (e: any) { toast.dismiss(toastId); toast.error(`Convert failed: ${e.message}`) } finally { setConverting(false) }
    }

    const handleDelete = async () => {
        if (!id || !confirm("Delete this draft order? This cannot be undone.")) return
        try {
            const r = await fetch(`/admin/draft-orders/${id}`, { method: "DELETE", credentials: "include" })
            if (!r.ok) throw new Error(`HTTP ${r.status}`)
            toast.success("Deleted"); navigate("/draft-orders-advanced")
        } catch (e: any) { toast.error(e.message) }
    }

    const handleStatusChange = async (val: string) => {
        setStatusSaving(true)
        try { await patchOrder({ metadata: { estimate_status: val } }); setEstimateStatus(val as EstimateStatus); toast.success(`Status → "${val}"`) } catch (e: any) { toast.error(e.message) } finally { setStatusSaving(false) }
    }

    const handleSync = async () => {
        if (!order) return; setSyncing(true); setSyncError(null)
        const isAlreadySynced = !!(order.metadata?.qb_estimate_txn_id)
        try {
            const r = await fetch("/admin/quickbooks/draft-order", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                credentials: "include",
                body: JSON.stringify({ orderId: order.id, force: isAlreadySynced }),
            })
            const j = await r.json()
            if (j.success) {
                if (j.qbEstimateTxnId) { setLocalTxnId(j.qbEstimateTxnId); setLocalRef(j.qbEstimateRef ?? j.qbEstimateTxnId) }
                toast.success(j.message || (isAlreadySynced ? "Re-synced to QuickBooks!" : "Saved to QuickBooks!"))
            } else { setSyncError(j.error || "Sync failed"); toast.error(j.error || "Sync failed") }
        } catch (e: any) { setSyncError(e.message); toast.error(e.message) } finally { setSyncing(false) }
    }

    const handleAddMetaKey = () => {
        if (metaNewKey.trim()) { setMetadataForm(m => ({ ...m, [metaNewKey.trim()]: metaNewVal })); setMetaNewKey(""); setMetaNewVal("") }
    }

    return {
        converting, handleConvert, handleDelete,
        estimateStatus, statusSaving, handleStatusChange,
        syncing, localRef, localTxnId, syncError, handleSync,
        metadataForm, setMetadataForm, metaNewKey, setMetaNewKey, metaNewVal, setMetaNewVal, handleAddMetaKey,
    }
}

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

/** Deactivates the QB Estimate for a given order (shared by Cancel & Delete). Non-fatal. */
async function deactivateQbEstimate(id: string): Promise<void> {
    try {
        const qbRes = await fetch("/admin/quickbooks/draft-order", {
            method: "DELETE",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ orderId: id }),
        })
        const qbJson = await qbRes.json().catch(() => ({}))
        if (!qbJson.success && !qbJson.skipped) {
            console.warn(`[QB] Estimate deactivation warning: ${qbJson.error}`)
        }
    } catch {
        // Network/timeout — non-fatal, caller proceeds anyway
    }
}

/** Owns convert, delete, cancel, status change, QB sync, and metadata key management. */
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

    // ── Convert ────────────────────────────────────────────────────────────────
    const handleConvert = async () => {
        const toastId = toast.loading("Converting to order… (Items with 0 stock will be accepted as backorders)")
        setConverting(true)
        try {
            const r = await fetch(`/admin/draft-orders/${id}/convert-force`, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" } })
            const j = await r.json()
            if (!r.ok) throw new Error(j.message || `HTTP ${r.status}: ${r.statusText}`)
            const orderId = j.order?.id ?? id

            // Stamp confirmed_at so POS Activity Log shows the correct conversion time
            // (same as POS handleConfirmOrder — backend stamps order_placed_at, we add confirmed_at)
            if (orderId) {
                fetch(`/admin/orders/${orderId}`, {
                    method: "POST",
                    credentials: "include",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ metadata: { confirmed_at: new Date().toISOString() } }),
                }).catch(() => { /* non-critical */ })
            }

            toast.dismiss(toastId)
            toast.success(j.backorder_items_enabled ? "Converted to order! Some items are on backorder." : "Converted to order! Redirecting…")
            navigate(`/orders/${orderId}`)
        } catch (e: any) { toast.dismiss(toastId); toast.error(`Convert failed: ${e.message}`) } finally { setConverting(false) }
    }

    // ── Delete flow (QB inactive + hard delete) ────────────────────────────────
    const [isConfirmingDelete, setIsConfirmingDelete] = useState(false)
    const [isDeleting, setIsDeleting] = useState(false)
    const initiateDelete = () => setIsConfirmingDelete(true)
    const cancelDelete = () => setIsConfirmingDelete(false)

    const handleDelete = async () => {
        if (!id) return
        setIsConfirmingDelete(false)
        setIsDeleting(true)
        const toastId = toast.loading("Deleting draft order…")
        try {
            await deactivateQbEstimate(id)
            const r = await fetch(`/admin/draft-orders/${id}`, { method: "DELETE", credentials: "include" })
            if (!r.ok) throw new Error(`HTTP ${r.status}`)
            toast.dismiss(toastId)
            toast.success("Draft order deleted successfully")
            setTimeout(() => navigate("/draft-orders-advanced"), 800)
        } catch (e: any) {
            toast.dismiss(toastId)
            toast.error(e.message)
        } finally {
            setIsDeleting(false)
        }
    }

    // ── Cancel flow (QB inactive + status → Cancelled, keep draft order) ───────
    const [isConfirmingCancel, setIsConfirmingCancel] = useState(false)
    const [isCancelling, setIsCancelling] = useState(false)
    const initiateCancel = () => setIsConfirmingCancel(true)
    const cancelCancel = () => setIsConfirmingCancel(false)

    const handleCancel = async () => {
        if (!id) return
        setIsConfirmingCancel(false)
        setIsCancelling(true)
        const toastId = toast.loading("Cancelling draft order…")
        try {
            await deactivateQbEstimate(id)
            await patchOrder({ metadata: { order_status: "Cancelled" } })
            setEstimateStatus("Cancelled")
            toast.dismiss(toastId)
            toast.success("Draft order cancelled. QuickBooks Estimate marked inactive.")
        } catch (e: any) {
            toast.dismiss(toastId)
            toast.error(`Cancel failed: ${e.message}`)
        } finally {
            setIsCancelling(false)
        }
    }

    // ── Status change ──────────────────────────────────────────────────────────
    const handleStatusChange = async (val: string) => {
        setStatusSaving(true)
        try { await patchOrder({ metadata: { order_status: val } }); setEstimateStatus(val as EstimateStatus); toast.success(`Status → "${val}"`) } catch (e: any) { toast.error(e.message) } finally { setStatusSaving(false) }
    }

    // ── QB Sync ────────────────────────────────────────────────────────────────
    const handleSync = async () => {
        if (!order) return; setSyncing(true); setSyncError(null)
        // Read from new JSON shape first, fallback to old flat field for backward compat
        const estMeta = order.metadata?.qb_estimate
        const existingTxnId =
            (estMeta && typeof estMeta === "object" ? (estMeta as any).txn_id : null) ??
            (order.metadata?.qb_estimate_txn_id as string | undefined) ??
            null
        const isAlreadySynced = !!existingTxnId
        const wasCancelled = estimateStatus === "Cancelled"
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
                // If this re-sync reactivated a cancelled estimate, reflect new status in UI immediately
                if (wasCancelled && isAlreadySynced) setEstimateStatus("Created")
                toast.success(j.message || (isAlreadySynced ? "Re-synced to QuickBooks!" : "Saved to QuickBooks!"))
            } else { setSyncError(j.error || "Sync failed"); toast.error(j.error || "Sync failed") }
        } catch (e: any) { setSyncError(e.message); toast.error(e.message) } finally { setSyncing(false) }
    }

    const handleAddMetaKey = () => {
        if (metaNewKey.trim()) { setMetadataForm(m => ({ ...m, [metaNewKey.trim()]: metaNewVal })); setMetaNewKey(""); setMetaNewVal("") }
    }

    return {
        converting, handleConvert,
        isConfirmingDelete, isDeleting, initiateDelete, cancelDelete, handleDelete,
        isConfirmingCancel, isCancelling, initiateCancel, cancelCancel, handleCancel,
        estimateStatus, statusSaving, handleStatusChange,
        syncing, localRef, localTxnId, syncError, handleSync,
        metadataForm, setMetadataForm, metaNewKey, setMetaNewKey, metaNewVal, setMetaNewVal, handleAddMetaKey,
    }
}

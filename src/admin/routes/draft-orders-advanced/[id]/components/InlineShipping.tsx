import { useState, useCallback, useRef, forwardRef, useImperativeHandle } from "react"
import { Text, Button, Label } from "@medusajs/ui"
import { Trash } from "@medusajs/icons"
import { fmt } from "../helpers"
import { toast } from "@medusajs/ui"

interface Props {
    orderId: string
    shippingMethods: any[]
    shippingOptions: { id: string; name: string; amount: number | null }[]
    curr: string
    /** True while any shipping save is in progress — suppresses concurrent actions */
    shippingSaving: boolean
    loadShippingOptions: () => Promise<void>
    handleAddShipping: (optionId: string, customAmount?: string) => Promise<void>
    /** Optimistic-only remove from parent state (no API call) */
    onRemoved?: (methodId: string) => void
    /** Called after any shipping mutation so parent can bump taxes */
    onShippingChanged?: () => void
    /** Atomic replace: remove old + add new (includes API calls) */
    onReplaceShipping?: (oldMethodId: string, newOptionId: string, customAmount?: string) => Promise<void>
    /** Update amount: remove + re-add with same option (includes API calls) */
    onUpdateShippingAmount?: (methodId: string, optionId: string, newAmount: number, onShippingChanged?: () => void) => Promise<void>
    /** Title for the widget header */
    title?: string
}

export interface InlineShippingHandle {
    openPicker: () => Promise<void>
    /** Auto-apply Miami Store Pickup with $0, returns true if found */
    applyLocalPickup: () => Promise<boolean>
}

const PICKUP_KEYWORDS = ["pickup", "store pickup", "local pickup", "in store", "in-store", "miami"]
const isPickup = (name: string) => PICKUP_KEYWORDS.some(k => name.toLowerCase().includes(k))

export const InlineShipping = forwardRef<InlineShippingHandle, Props>(function InlineShipping({
    orderId, shippingMethods, shippingOptions, curr, shippingSaving,
    loadShippingOptions, handleAddShipping, onRemoved, onShippingChanged,
    onReplaceShipping, onUpdateShippingAmount, title = "Shipping",
}, ref) {
    const [picking, setPicking] = useState(false)
    const [replacingMethodId, setReplacingMethodId] = useState<string | null>(null)
    const [selectedOption, setSelectedOption] = useState("")
    const [customAmount, setCustomAmount] = useState("")
    const [applyingInPicker, setApplyingInPicker] = useState(false)
    const [removingId, setRemovingId] = useState<string | null>(null)
    const [addingPickup, setAddingPickup] = useState(false)

    // Per-method inline price editing
    const [priceState, setPriceState] = useState<Record<string, { value: string; editing: boolean; saving: boolean }>>({})
    const saveTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({})

    const getPriceState = (methodId: string, defaultAmount: number) =>
        priceState[methodId] ?? { value: String(defaultAmount), editing: false, saving: false }

    const openPicker = async (methodIdToReplace?: string) => {
        await loadShippingOptions()
        setReplacingMethodId(methodIdToReplace ?? null)
        setPicking(true)
        setSelectedOption("")
        setCustomAmount("")
    }

    const applyLocalPickup = async (): Promise<boolean> => {
        await loadShippingOptions()
        const opt = shippingOptions.find(o =>
            o.name.toLowerCase().includes("miami") || isPickup(o.name)
        )
        if (!opt) return false
        await handleAddShipping(opt.id, "0")
        onShippingChanged?.()
        return true
    }

    useImperativeHandle(ref, () => ({ openPicker, applyLocalPickup }))

    const handleLocalPickup = async () => {
        setAddingPickup(true)
        try {
            const found = await applyLocalPickup()
            if (!found) {
                toast.warning("Miami Store Pickup not found — please select manually.")
                await openPicker()
            }
        } catch (e: any) {
            toast.error(e.message)
        } finally {
            setAddingPickup(false)
        }
    }

    const handleOptionClick = (optId: string, optName: string) => {
        setSelectedOption(optId)
        if (isPickup(optName)) setCustomAmount("0")
        else setCustomAmount("")
    }

    const handleAmountChange = (raw: string) => {
        const cleaned = raw.replace(/^\$/, "").replace(/[^0-9.]/g, "")
        setCustomAmount(cleaned)
    }

    const handleRemove = useCallback(async (methodId: string) => {
        onRemoved?.(methodId)
        setRemovingId(methodId)
        try {
            const r = await fetch(`/admin/draft-orders/${orderId}/remove-shipping/${methodId}`, {
                method: "DELETE",
                credentials: "include",
            })
            if (!r.ok) {
                const j = await r.json().catch(() => ({}))
                throw new Error(j.message || `HTTP ${r.status}`)
            }
            toast.success("Shipping method removed")
            onShippingChanged?.()
        } catch (e: any) {
            toast.error(e.message)
        } finally {
            setRemovingId(null)
        }
    }, [orderId, onRemoved, onShippingChanged])

    // ── Inline price editing ────────────────────────────────────────────────────
    const handlePriceFocus = (methodId: string, currentAmount: number) => {
        setPriceState(prev => ({ ...prev, [methodId]: { value: String(currentAmount), editing: true, saving: false } }))
    }

    const handlePriceChange = (methodId: string, raw: string) => {
        const cleaned = raw.replace(/[^0-9.]/g, "")
        setPriceState(prev => ({ ...prev, [methodId]: { ...getPriceState(methodId, 0), value: cleaned, editing: true } }))
    }

    const handlePriceBlur = (method: any) => {
        const methodId = method.id
        const ps = getPriceState(methodId, method.amount ?? 0)
        const newAmount = parseFloat(ps.value)

        if (isNaN(newAmount) || newAmount < 0) {
            setPriceState(prev => { const n = { ...prev }; delete n[methodId]; return n })
            return
        }
        if (newAmount === (method.amount ?? 0)) {
            setPriceState(prev => ({ ...prev, [methodId]: { ...ps, editing: false } }))
            return
        }

        const optionId = method.shipping_option_id
        if (!optionId) {
            toast.error("Cannot update price: shipping_option_id not found")
            setPriceState(prev => { const n = { ...prev }; delete n[methodId]; return n })
            return
        }

        clearTimeout(saveTimers.current[methodId])
        saveTimers.current[methodId] = setTimeout(async () => {
            setPriceState(prev => ({ ...prev, [methodId]: { value: String(newAmount), editing: false, saving: true } }))
            try {
                // Pass onShippingChanged so tax re-fetches AFTER server confirms the new amount
                await onUpdateShippingAmount?.(methodId, optionId, newAmount, onShippingChanged)
            } catch (e: any) {
                toast.error(e.message)
            } finally {
                setPriceState(prev => { const n = { ...prev }; delete n[methodId]; return n })
            }
        }, 600)

        setPriceState(prev => ({ ...prev, [methodId]: { value: String(newAmount), editing: false, saving: true } }))
    }

    // ── Change method (replace) ─────────────────────────────────────────────────
    const save = async () => {
        if (!selectedOption || applyingInPicker) return
        setApplyingInPicker(true)
        try {
            if (replacingMethodId) {
                await onReplaceShipping?.(replacingMethodId, selectedOption, customAmount || undefined)
            } else {
                await handleAddShipping(selectedOption, customAmount)
            }
            onShippingChanged?.()
            setPicking(false)
            setReplacingMethodId(null)
            setSelectedOption("")
            setCustomAmount("")
        } finally {
            setApplyingInPicker(false)
        }
    }

    return (
        <div>
            {/* ── Header row: title + quick-action buttons ── */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-ui-border-base">
                <div className="flex items-center gap-2">
                    <span className="text-ui-fg-base text-base font-medium">{title}</span>
                    {shippingSaving && <Text size="xsmall" className="text-ui-fg-muted">Saving...</Text>}
                </div>
                <div className="flex items-center gap-2">
                    {/* Hide Local Pickup button if a pickup method is already active */}
                    {!shippingMethods.some(m => isPickup(m.name ?? "")) && (
                        <Button
                            variant="secondary"
                            size="small"
                            onClick={handleLocalPickup}
                            isLoading={addingPickup}
                            disabled={addingPickup || shippingSaving}
                        >
                            🏪 Local Pickup
                        </Button>
                    )}
                    <Button
                        variant="secondary"
                        size="small"
                        onClick={() => openPicker()}
                        disabled={addingPickup || shippingSaving}
                    >
                        Add shipping
                    </Button>
                </div>
            </div>

            {/* ── Existing shipping methods ── */}
            {shippingMethods.length > 0 && shippingMethods.map(m => {
                const ps = getPriceState(m.id, m.amount ?? 0)
                return (
                    <div key={m.id} className="flex items-center justify-between px-6 py-3 border-b border-ui-border-base last:border-b-0">
                        <div>
                            <Text size="small" weight="plus">{m.name}</Text>
                            <Text size="xsmall" className="text-ui-fg-muted">{m.data?.description ?? ""}</Text>
                        </div>
                        <div className="flex items-center gap-3">
                            {/* ── Inline editable amount — styled like Items price ── */}
                            {ps.saving ? (
                                <Text size="small" className="text-ui-fg-muted w-24 text-right">Saving...</Text>
                            ) : (
                                <div className="flex items-center border border-ui-border-base rounded-md overflow-hidden bg-ui-bg-base focus-within:ring-1 focus-within:ring-ui-border-interactive h-7">
                                    <span className="px-2 text-xs text-ui-fg-muted border-r border-ui-border-base bg-ui-bg-subtle select-none h-full flex items-center">$</span>
                                    <input
                                        type="text"
                                        inputMode="decimal"
                                        value={ps.editing ? ps.value : String(m.amount ?? 0)}
                                        onFocus={() => handlePriceFocus(m.id, m.amount ?? 0)}
                                        onChange={e => handlePriceChange(m.id, e.target.value)}
                                        onBlur={() => handlePriceBlur(m)}
                                        className="w-16 px-2 text-xs text-right text-ui-fg-base bg-transparent focus:outline-none"
                                        title="Click to edit shipping amount"
                                    />
                                </div>
                            )}
                            <button
                                onClick={() => openPicker(m.id)}
                                className="text-xs text-ui-fg-interactive hover:underline whitespace-nowrap"
                            >
                                Change method
                            </button>
                            <button
                                onClick={() => handleRemove(m.id)}
                                disabled={removingId === m.id}
                                className="text-ui-fg-muted hover:text-ui-fg-error transition-colors disabled:opacity-40"
                                title="Remove shipping method"
                            >
                                {removingId === m.id
                                    ? <span className="text-xs">...</span>
                                    : <Trash className="w-3.5 h-3.5" />}
                            </button>
                        </div>
                    </div>
                )
            })}

            {/* ── Empty state ── */}
            {shippingMethods.length === 0 && (
                <div className="px-6 py-3">
                    <Text size="small" className="text-ui-fg-muted">No shipping method selected.</Text>
                </div>
            )}

            {/* ── Method picker panel ── */}
            {picking && (
                <div className="px-6 py-4 border-t border-ui-border-base bg-ui-bg-subtle space-y-3">
                    <Text size="small" weight="plus">
                        {replacingMethodId ? "Replace shipping method" : "Select shipping method"}
                    </Text>
                    <div className="space-y-2">
                        {shippingOptions.map(o => (
                            <button key={o.id} onClick={() => handleOptionClick(o.id, o.name)}
                                className={`w-full flex items-center justify-between px-3 py-2 rounded-md border transition-colors text-left ${selectedOption === o.id ? "border-ui-border-interactive bg-ui-bg-interactive" : "border-ui-border-base hover:bg-ui-bg-base"}`}>
                                <Text size="small">{o.name}</Text>
                                <Text size="small" className="text-ui-fg-subtle">
                                    {o.amount != null ? fmt(o.amount, curr) : "Custom"}
                                </Text>
                            </button>
                        ))}
                    </div>
                    <div>
                        <Label className="text-xs text-ui-fg-muted block mb-1">Custom amount (optional)</Label>
                        <div className="flex items-center border border-ui-border-base rounded-md overflow-hidden bg-ui-bg-base focus-within:ring-1 focus-within:ring-ui-border-interactive">
                            <span className="px-3 py-2 text-sm text-ui-fg-muted border-r border-ui-border-base bg-ui-bg-subtle select-none">$</span>
                            <input
                                type="text"
                                inputMode="decimal"
                                value={customAmount}
                                onChange={e => handleAmountChange(e.target.value)}
                                placeholder="Leave blank to use option price"
                                className="flex-1 px-3 py-2 text-sm bg-transparent text-ui-fg-base placeholder:text-ui-fg-muted focus:outline-none"
                            />
                        </div>
                    </div>
                    <div className="flex gap-2">
                        <Button
                            size="small"
                            onClick={save}
                            isLoading={applyingInPicker}
                            disabled={!selectedOption || applyingInPicker}
                        >
                            {replacingMethodId ? "Replace" : "Apply"}
                        </Button>
                        <Button
                            size="small"
                            variant="secondary"
                            disabled={applyingInPicker}
                            onClick={() => { setPicking(false); setReplacingMethodId(null); setSelectedOption(""); setCustomAmount("") }}
                        >
                            Cancel
                        </Button>
                    </div>
                </div>
            )}
        </div>
    )
})

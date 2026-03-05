import { useState, useCallback, forwardRef, useImperativeHandle } from "react"
import { Text, Button, Label } from "@medusajs/ui"
import { Trash } from "@medusajs/icons"
import { fmt } from "../helpers"
import { toast } from "@medusajs/ui"

interface Props {
    orderId: string
    shippingMethods: any[]
    shippingOptions: { id: string; name: string; amount: number | null }[]
    curr: string
    saving: boolean
    loadShippingOptions: () => Promise<void>
    handleAddShipping: (optionId: string, customAmount?: string) => Promise<void>
    /** Called with the removed method ID so parent can patch local state optimistically */
    onRemoved?: (methodId: string) => void
}

export interface InlineShippingHandle {
    openPicker: () => Promise<void>
    /** Auto-apply Miami Store Pickup with $0, returns true if found */
    applyLocalPickup: () => Promise<boolean>
}

const PICKUP_KEYWORDS = ["pickup", "store pickup", "local pickup", "in store", "in-store", "miami"]
const isPickup = (name: string) => PICKUP_KEYWORDS.some(k => name.toLowerCase().includes(k))

export const InlineShipping = forwardRef<InlineShippingHandle, Props>(function InlineShipping({
    orderId, shippingMethods, shippingOptions, curr, saving,
    loadShippingOptions, handleAddShipping, onRemoved,
}, ref) {
    const [picking, setPicking] = useState(false)
    const [selectedOption, setSelectedOption] = useState("")
    const [customAmount, setCustomAmount] = useState("")
    const [removingId, setRemovingId] = useState<string | null>(null)
    const [addingPickup, setAddingPickup] = useState(false)

    const openPicker = async () => {
        await loadShippingOptions()
        setPicking(true)
    }

    const applyLocalPickup = async (): Promise<boolean> => {
        await loadShippingOptions()
        // Find Miami Store Pickup — match by name containing miami or pickup keywords
        const opt = shippingOptions.find(o =>
            o.name.toLowerCase().includes("miami") ||
            isPickup(o.name)
        )
        if (!opt) return false
        await handleAddShipping(opt.id, "0")
        return true
    }

    useImperativeHandle(ref, () => ({ openPicker, applyLocalPickup }))

    const handleLocalPickup = async () => {
        setAddingPickup(true)
        try {
            const found = await applyLocalPickup()
            if (!found) {
                // Fallback: open picker so user can choose
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

    const save = async () => {
        if (!selectedOption) return
        await handleAddShipping(selectedOption, customAmount)
        setPicking(false)
        setSelectedOption("")
        setCustomAmount("")
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
        } catch (e: any) {
            toast.error(e.message)
        } finally {
            setRemovingId(null)
        }
    }, [orderId, onRemoved])

    return (
        <div>
            {shippingMethods.length > 0 ? shippingMethods.map(m => (
                <div key={m.id} className="flex items-center justify-between px-6 py-3 border-b border-ui-border-base">
                    <div>
                        <Text size="small" weight="plus">{m.name}</Text>
                        <Text size="xsmall" className="text-ui-fg-muted">{m.data?.description ?? ""}</Text>
                    </div>
                    <div className="flex items-center gap-3">
                        <Text size="small">{fmt(typeof m.amount === "number" ? m.amount : 0, curr)}</Text>
                        <button onClick={openPicker} className="text-xs text-ui-fg-interactive hover:underline">Change</button>
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
            )) : (
                /* ── No shipping selected: show two quick-action buttons ── */
                <div className="px-6 py-4 flex items-center justify-between gap-3">
                    <Text size="small" className="text-ui-fg-subtle">No shipping method selected.</Text>
                    <div className="flex items-center gap-2">
                        <Button
                            variant="secondary"
                            size="small"
                            onClick={handleLocalPickup}
                            isLoading={addingPickup}
                            disabled={addingPickup || saving}
                        >
                            🏪 Local Pickup
                        </Button>
                        <Button
                            variant="secondary"
                            size="small"
                            onClick={openPicker}
                            disabled={addingPickup || saving}
                        >
                            Add shipping
                        </Button>
                    </div>
                </div>
            )}

            {picking && (
                <div className="px-6 py-4 border-t border-ui-border-base bg-ui-bg-subtle space-y-3">
                    <Text size="small" weight="plus">Select shipping method</Text>
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
                        <Button size="small" onClick={save} isLoading={saving} disabled={!selectedOption || saving}>Apply</Button>
                        <Button size="small" variant="secondary" onClick={() => { setPicking(false); setSelectedOption(""); setCustomAmount("") }}>Cancel</Button>
                    </div>
                </div>
            )}
        </div>
    )
})

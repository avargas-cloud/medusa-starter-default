import { useState, useRef, useEffect, useCallback } from "react"
import { Text } from "@medusajs/ui"
import { MagnifyingGlass, XMark, Plus, Minus, Trash } from "@medusajs/icons"
import { PriceCombobox, PriceOption } from "./PriceCombobox"
import { fmt } from "../helpers"

interface VariantResult {
    id: string
    title: string
    sku?: string
    variantTitle?: string
    thumbnail?: string
    prices?: PriceOption[]
}

interface Props {
    items: any[]
    curr: string
    invQuery: string
    invResults: VariantResult[]
    itemQtys: Record<string, number>
    setItemQtys: (v: any) => void
    itemPrices: Record<string, string>
    setItemPrices: (v: any) => void
    searchInvItems: (q: string) => void
    handleAddItem: (variantId: string, overridePrice?: number) => Promise<void>
    handleUpdateItem: (itemId: string) => Promise<void>
    handleRemoveItem: (itemId: string) => Promise<void>
    itemSaving: boolean
    customerPrices: Record<string, PriceOption[]>
}

const AUTOSAVE_DELAY = 3000 // 3 seconds debounce

export const InlineItemsTable = ({
    items, curr,
    invQuery, invResults,
    itemQtys, setItemQtys,
    itemPrices, setItemPrices,
    searchInvItems, handleAddItem, handleUpdateItem, handleRemoveItem,
    itemSaving, customerPrices,
}: Props) => {
    const searchRef = useRef<HTMLInputElement>(null)
    const dropdownRef = useRef<HTMLDivElement>(null)
    const [showDropdown, setShowDropdown] = useState(false)
    const [dropPos, setDropPos] = useState<{ top: number; left: number; width: number } | null>(null)

    // Track pending auto-save timers per item
    const autoSaveTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({})
    // Track which items are "dirty" (have unsaved changes)
    const [savingItems, setSavingItems] = useState<Set<string>>(new Set())
    const [savedItems, setSavedItems] = useState<Set<string>>(new Set())

    const triggerAutoSave = useCallback((itemId: string) => {
        // Clear existing timer for this item
        if (autoSaveTimers.current[itemId]) {
            clearTimeout(autoSaveTimers.current[itemId])
        }
        // Schedule save after 3 seconds
        autoSaveTimers.current[itemId] = setTimeout(async () => {
            setSavingItems(prev => new Set([...prev, itemId]))
            await handleUpdateItem(itemId)
            setSavingItems(prev => { const s = new Set(prev); s.delete(itemId); return s })
            setSavedItems(prev => new Set([...prev, itemId]))
            // Clear the "saved" indicator after 2s
            setTimeout(() => {
                setSavedItems(prev => { const s = new Set(prev); s.delete(itemId); return s })
            }, 2000)
        }, AUTOSAVE_DELAY)
    }, [handleUpdateItem])

    const saveOnBlur = useCallback(async (itemId: string) => {
        // If there's a pending timer, cancel it and save immediately
        if (autoSaveTimers.current[itemId]) {
            clearTimeout(autoSaveTimers.current[itemId])
            delete autoSaveTimers.current[itemId]
            setSavingItems(prev => new Set([...prev, itemId]))
            await handleUpdateItem(itemId)
            setSavingItems(prev => { const s = new Set(prev); s.delete(itemId); return s })
            setSavedItems(prev => new Set([...prev, itemId]))
            setTimeout(() => {
                setSavedItems(prev => { const s = new Set(prev); s.delete(itemId); return s })
            }, 2000)
        }
    }, [handleUpdateItem])

    // Cleanup timers on unmount
    useEffect(() => {
        return () => {
            Object.values(autoSaveTimers.current).forEach(clearTimeout)
        }
    }, [])

    // Compute dropdown fixed position when results arrive
    useEffect(() => {
        if (invResults.length > 0) {
            setShowDropdown(true)
            if (searchRef.current) {
                const rect = searchRef.current.closest(".search-container")?.getBoundingClientRect()
                    ?? searchRef.current.getBoundingClientRect()
                setDropPos({ top: rect.bottom + 4, left: rect.left, width: rect.width })
            }
        } else {
            setShowDropdown(false)
        }
    }, [invResults])

    // Close dropdown on outside click
    useEffect(() => {
        const handler = (e: MouseEvent) => {
            if (
                dropdownRef.current && !dropdownRef.current.contains(e.target as Node) &&
                searchRef.current && !searchRef.current.contains(e.target as Node)
            ) setShowDropdown(false)
        }
        document.addEventListener("mousedown", handler)
        return () => document.removeEventListener("mousedown", handler)
    }, [])

    return (
        <div>
            {/* ── Search box ── */}
            <div className="search-container px-6 py-3 border-b border-ui-border-base bg-ui-bg-subtle">
                <div className="relative">
                    <div className="flex items-center gap-2 border border-ui-border-base rounded-md bg-ui-bg-base px-3 py-2 focus-within:ring-1 focus-within:ring-ui-border-interactive">
                        <MagnifyingGlass className="text-ui-fg-muted shrink-0" />
                        <input
                            ref={searchRef}
                            value={invQuery}
                            onChange={e => { searchInvItems(e.target.value); if (!e.target.value) setShowDropdown(false) }}
                            onFocus={() => { if (invResults.length > 0) setShowDropdown(true) }}
                            placeholder="Search products by name or SKU to add..."
                            className="flex-1 bg-transparent text-sm text-ui-fg-base outline-none placeholder:text-ui-fg-muted"
                        />
                        {invQuery && (
                            <button onClick={() => { searchInvItems(""); setShowDropdown(false) }} className="text-ui-fg-muted hover:text-ui-fg-base">
                                <XMark />
                            </button>
                        )}
                    </div>

                    {/* Dropdown: position:fixed escapes any overflow:hidden ancestor */}
                    {showDropdown && invResults.length > 0 && dropPos && (
                        <div
                            ref={dropdownRef}
                            style={{ position: "fixed", top: dropPos.top, left: dropPos.left, width: dropPos.width, zIndex: 9999 }}
                            className="bg-ui-bg-base border-2 border-ui-border-interactive rounded-lg shadow-2xl max-h-[440px] overflow-y-auto ring-1 ring-black/10"
                        >
                            {invResults.map(v => {
                                const prices = (v.prices ?? []) as PriceOption[]
                                const defaultP = prices.find(p => !p.priceListId) ?? prices[0]
                                const contractorP = prices.find(p => p.priceListId)
                                return (
                                    <button
                                        key={v.id}
                                        disabled={itemSaving}
                                        className="w-full flex items-center gap-3 px-3 py-2.5 hover:bg-ui-bg-subtle border-b border-ui-border-base last:border-0 text-left disabled:opacity-50"
                                        onClick={() => {
                                            const price = contractorP ?? defaultP
                                            handleAddItem(v.id, price?.amount)
                                            setShowDropdown(false)
                                        }}
                                    >
                                        {v.thumbnail ? (
                                            <img src={v.thumbnail} alt="" className="w-9 h-9 object-cover rounded border border-ui-border-base shrink-0" />
                                        ) : (
                                            <div className="w-9 h-9 bg-ui-bg-subtle rounded border border-ui-border-base shrink-0 flex items-center justify-center text-ui-fg-muted text-xs">IMG</div>
                                        )}
                                        <div className="flex-1 min-w-0">
                                            <Text size="small" weight="plus" className="truncate block">{v.title}</Text>
                                            {v.variantTitle && <Text size="xsmall" className="text-ui-fg-subtle truncate block">{v.variantTitle}</Text>}
                                            {v.sku && <Text size="xsmall" className="text-ui-fg-muted font-mono">{v.sku}</Text>}
                                        </div>
                                        <div className="text-right shrink-0 space-y-0.5">
                                            {defaultP && <Text size="xsmall" className="text-ui-fg-muted block">Default: {fmt(defaultP.amount, "usd")}</Text>}
                                            {contractorP && <Text size="xsmall" className="text-ui-fg-interactive font-medium block">{contractorP.label ?? "Wholesale"}: {fmt(contractorP.amount, "usd")} ✓</Text>}
                                        </div>
                                    </button>
                                )
                            })}
                        </div>
                    )}
                </div>
            </div>

            {/* ── Column headers ── */}
            {items.length > 0 && (
                <div className="grid grid-cols-[2.5rem_1fr_10rem_6rem_5.5rem_1.5rem] gap-x-3 px-6 py-2 border-b border-ui-border-base">
                    <div />
                    <Text size="xsmall" weight="plus" className="text-ui-fg-muted uppercase tracking-wide">Item</Text>
                    <Text size="xsmall" weight="plus" className="text-ui-fg-muted uppercase tracking-wide text-right">Price</Text>
                    <Text size="xsmall" weight="plus" className="text-ui-fg-muted uppercase tracking-wide text-center">Qty</Text>
                    <Text size="xsmall" weight="plus" className="text-ui-fg-muted uppercase tracking-wide text-right">Total</Text>
                    <div />
                </div>
            )}

            {/* ── Item rows ── */}
            {items.length === 0 ? (
                <div className="px-6 py-8 text-center">
                    <Text size="small" className="text-ui-fg-subtle">No items yet. Search above to add products.</Text>
                </div>
            ) : items.map(item => {
                const qty = itemQtys[item.id] ?? item.quantity
                const rawUnitPrice = item.unit_price ?? 0
                const priceStr = itemPrices[item.id] ?? parseFloat(String(rawUnitPrice)).toFixed(2)
                const price = parseFloat(priceStr) || 0
                const options = customerPrices[item.variant?.id ?? item.variant_id ?? ""] ?? []
                const subtotal = price * qty
                const isSaving = savingItems.has(item.id)
                const isSaved = savedItems.has(item.id)

                return (
                    <div key={item.id} className="group grid grid-cols-[2.5rem_1fr_10rem_6rem_5.5rem_1.5rem] gap-x-3 items-center px-6 py-3 border-b border-ui-border-base last:border-0 hover:bg-ui-bg-subtle transition-colors">
                        {/* Thumbnail */}
                        {item.thumbnail ? (
                            <img src={item.thumbnail} alt="" className="w-9 h-9 object-cover rounded border border-ui-border-base" />
                        ) : (
                            <div className="w-9 h-9 bg-ui-bg-subtle rounded border border-ui-border-base flex items-center justify-center text-xs text-ui-fg-muted">—</div>
                        )}

                        {/* Title / SKU */}
                        <div className="min-w-0">
                            <Text size="small" weight="plus" className="block leading-tight">{item.title}</Text>
                            {item.variant?.title && <Text size="xsmall" className="text-ui-fg-subtle">{item.variant.title}</Text>}
                            {item.variant?.sku && <Text size="xsmall" className="text-ui-fg-muted font-mono">{item.variant.sku}</Text>}
                        </div>

                        {/* Price — auto-saves on blur or after 3s of inactivity */}
                        <div className="flex items-center justify-end gap-1">
                            {isSaving && (
                                <span className="text-[10px] text-ui-fg-muted animate-pulse">saving…</span>
                            )}
                            {isSaved && !isSaving && (
                                <span className="text-[10px] text-ui-fg-interactive">✓</span>
                            )}
                            <PriceCombobox
                                value={priceStr}
                                onChange={v => {
                                    setItemPrices((p: any) => ({ ...p, [item.id]: v }))
                                    triggerAutoSave(item.id)
                                }}
                                onBlur={() => saveOnBlur(item.id)}
                                options={options}
                                onSelectOption={(amount) => {
                                    setItemPrices((p: any) => ({ ...p, [item.id]: amount.toFixed(2) }))
                                    // Immediate save when selecting from dropdown
                                    if (autoSaveTimers.current[item.id]) {
                                        clearTimeout(autoSaveTimers.current[item.id])
                                        delete autoSaveTimers.current[item.id]
                                    }
                                    setTimeout(() => handleUpdateItem(item.id), 50)
                                }}
                            />
                        </div>

                        {/* Qty stepper — always visible */}
                        <div className="flex items-center gap-1 justify-center">
                            <button
                                onClick={() => {
                                    setItemQtys((q: any) => ({ ...q, [item.id]: Math.max(1, (q[item.id] ?? item.quantity) - 1) }))
                                    triggerAutoSave(item.id)
                                }}
                                className="w-5 h-5 flex items-center justify-center border border-ui-border-base rounded hover:bg-ui-bg-base text-ui-fg-muted"
                            >
                                <Minus />
                            </button>
                            <span className="w-7 text-center text-sm font-medium tabular-nums">{qty}</span>
                            <button
                                onClick={() => {
                                    setItemQtys((q: any) => ({ ...q, [item.id]: (q[item.id] ?? item.quantity) + 1 }))
                                    triggerAutoSave(item.id)
                                }}
                                className="w-5 h-5 flex items-center justify-center border border-ui-border-base rounded hover:bg-ui-bg-base text-ui-fg-muted"
                            >
                                <Plus />
                            </button>
                        </div>

                        {/* Row total */}
                        <Text size="small" className="text-right min-w-[5rem] tabular-nums">
                            {fmt(subtotal, curr)}
                        </Text>

                        {/* Delete button (always visible on hover) */}
                        <button
                            onClick={() => handleRemoveItem(item.id)}
                            disabled={itemSaving || isSaving}
                            title="Remove item"
                            className="w-5 h-5 flex items-center justify-center text-ui-fg-muted hover:text-ui-fg-error hover:bg-ui-bg-subtle rounded opacity-0 group-hover:opacity-100 transition-opacity disabled:opacity-50"
                        >
                            <Trash />
                        </button>
                    </div>
                )
            })}
        </div>
    )
}

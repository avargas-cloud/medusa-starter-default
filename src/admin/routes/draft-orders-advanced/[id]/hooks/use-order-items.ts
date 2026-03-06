import { useState, useRef } from "react"
import { toast } from "@medusajs/ui"
import { DraftOrderDetail, VariantResult } from "../types"

interface Deps {
    id: string | undefined
    order: DraftOrderDetail | null
    setOrder: React.Dispatch<React.SetStateAction<DraftOrderDetail | null>>
}

/** Owns variant search, item CRUD (add/update/remove), and per-item qty/price state. */
export const useOrderItems = ({ id, order, setOrder }: Deps) => {
    const [invQuery, setInvQuery] = useState("")
    const [invResults, setInvResults] = useState<VariantResult[]>([])
    const [itemQtys, setItemQtys] = useState<Record<string, number>>({})
    const [itemPrices, setItemPrices] = useState<Record<string, string>>({})
    const [itemSaving, setItemSaving] = useState(false)
    const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

    // Refs so handleUpdateItem always reads the latest state (avoids stale closure)
    const itemQtysRef = useRef<Record<string, number>>({})
    const itemPricesRef = useRef<Record<string, string>>({})
    const orderRef = useRef<DraftOrderDetail | null>(order)  // always current — updated on every render
    orderRef.current = order  // keep in sync without re-creating handleUpdateItem

    const setItemQtysSafe = (v: any) => {
        const next = typeof v === "function" ? v(itemQtysRef.current) : v
        itemQtysRef.current = next
        setItemQtys(next)
    }
    const setItemPricesSafe = (v: any) => {
        const next = typeof v === "function" ? v(itemPricesRef.current) : v
        itemPricesRef.current = next
        setItemPrices(next)
    }

    // ── Variant/SKU search ───────────────────────────────────────────────────
    const searchInvItems = (q: string) => {
        setInvQuery(q)
        if (searchTimer.current) clearTimeout(searchTimer.current)
        searchTimer.current = setTimeout(async () => {
            if (!q) { setInvResults([]); return }
            try {
                const varRes = await fetch(`/admin/product-variants?q=${encodeURIComponent(q)}&limit=20`, { credentials: "include" })
                if (!varRes.ok) { setInvResults([]); return }
                const { variants } = await varRes.json()
                if (!variants?.length) { setInvResults([]); return }

                const productIds = [...new Set<string>((variants as any[]).map((v: any) => v.product_id).filter(Boolean))]
                const productMap: Record<string, any> = {}
                if (productIds.length > 0) {
                    const pRes = await fetch(`/admin/products?${productIds.map((pid: string) => `id[]=${encodeURIComponent(pid)}`).join("&")}&limit=20`, { credentials: "include" })
                    if (pRes.ok) { const { products } = await pRes.json(); (products ?? []).forEach((p: any) => { productMap[p.id] = p }) }
                }

                let priceMap: Record<string, any> = {}
                try {
                    if (id) {
                        const vidsParam = (variants as any[]).map((v: any) => `variant_ids[]=${v.id}`).join("&")
                        const prRes = await fetch(`/admin/draft-orders/${id}/variant-prices?${vidsParam}`, { credentials: "include" })
                        if (prRes.ok) { const { prices } = await prRes.json(); priceMap = prices ?? {} }
                    }
                } catch { /* best-effort */ }

                let locationMap: Record<string, { locationName: string; available: number }[]> = {}
                try {
                    const skus = (variants as any[]).map((v: any) => v.sku).filter(Boolean)
                    if (skus.length > 0) {
                        const locationNameMap: Record<string, string> = {}
                        try {
                            const slRes = await fetch(`/admin/stock-locations?limit=100`, { credentials: "include" })
                            if (slRes.ok) { const { stock_locations } = await slRes.json(); for (const sl of (stock_locations ?? [])) { if (sl.id && sl.name) locationNameMap[sl.id] = sl.name } }
                        } catch { }
                        const skuParams = skus.map((s: string) => `sku[]=${encodeURIComponent(s)}`).join("&")
                        const invRes = await fetch(`/admin/inventory-items?${skuParams}&limit=50`, { credentials: "include" })
                        if (invRes.ok) {
                            const { inventory_items } = await invRes.json()
                            const levelFetches = (inventory_items ?? []).map(async (inv: any) => {
                                const levRes = await fetch(`/admin/inventory-items/${inv.id}/location-levels?limit=50`, { credentials: "include" })
                                if (!levRes.ok) return
                                const { inventory_levels } = await levRes.json()
                                const matchedVariant = (variants as any[]).find((v: any) => v.sku === inv.sku)
                                if (!matchedVariant) return
                                const vid = matchedVariant.id
                                if (!locationMap[vid]) locationMap[vid] = []
                                for (const lev of (inventory_levels ?? [])) {
                                    const locId: string = lev.location_id ?? ""
                                    const locName: string = locationNameMap[locId] ?? lev.location?.name ?? lev.stock_location?.name ?? (locId || "Warehouse")
                                    locationMap[vid].push({ locationName: locName, available: (lev.stocked_quantity ?? 0) - (lev.reserved_quantity ?? 0) })
                                }
                            })
                            await Promise.allSettled(levelFetches)
                        }
                    }
                } catch { }

                const results: VariantResult[] = (variants as any[]).map((v: any) => {
                    const prod = productMap[v.product_id]
                    const varPrices = priceMap[v.id]
                    const priceOptions: any[] = []
                    if (varPrices?.default) priceOptions.push({ label: "Default", amount: varPrices.default.amount })
                    for (const lp of (varPrices?.list ?? [])) {
                        const rawLabel: string = lp.price_list_name ?? "Price List"
                        const shortLabel = rawLabel.replace(/\s+Price(s)?$/i, "").trim() || rawLabel
                        priceOptions.push({ label: shortLabel, amount: lp.amount, priceListId: lp.price_list_id })
                    }
                    return {
                        id: v.id, title: prod?.title ?? v.title ?? v.sku ?? v.id, sku: v.sku ?? undefined,
                        variantTitle: v.title && v.title !== prod?.title ? v.title : undefined,
                        thumbnail: prod?.thumbnail ?? undefined,
                        prices: priceOptions.length > 0 ? priceOptions : undefined,
                        locations: locationMap[v.id] ?? [],
                    }
                })
                setInvResults(results)
            } catch { setInvResults([]) }
        }, 350)
    }

    // ── Add item ─────────────────────────────────────────────────────────────
    const handleAddItem = async (variantId: string, overridePrice?: number): Promise<void> => {
        setItemSaving(true)
        const matchedVariant = invResults.find(v => v.id === variantId)
        const optimisticItem = {
            id: `optimistic-${Date.now()}`, variant_id: variantId,
            variant: { id: variantId, sku: matchedVariant?.sku ?? "" },
            title: matchedVariant?.title ?? variantId, subtitle: matchedVariant?.variantTitle ?? "",
            thumbnail: matchedVariant?.thumbnail ?? null, quantity: 1,
            unit_price: overridePrice !== undefined ? overridePrice : 0,
        }
        setOrder(prev => prev ? { ...prev, items: [...(prev.items ?? []), optimisticItem as any] } : prev)
        setInvQuery(""); setInvResults([])
        try {
            let unitPrice: number | undefined = overridePrice
            if (unitPrice === undefined) {
                try {
                    const varRes = await fetch(`/admin/product-variants/${variantId}?fields=*prices`, { credentials: "include" })
                    if (varRes.ok) {
                        const { variant } = await varRes.json()
                        const allPrices: any[] = variant?.prices ?? []
                        const customerId = order?.customer?.id
                        if (customerId && allPrices.length > 0) {
                            try {
                                const [plRes, custRes] = await Promise.all([
                                    fetch(`/admin/price-lists?offset=0&limit=100`, { credentials: "include" }),
                                    fetch(`/admin/customers/${customerId}?fields=*groups`, { credentials: "include" })
                                ])
                                if (plRes.ok && custRes.ok) {
                                    const { price_lists } = await plRes.json()
                                    const { customer } = await custRes.json()
                                    const groupIds = new Set((customer?.groups ?? []).map((g: any) => g.id))
                                    const applicablePLIds = new Set((price_lists ?? []).filter((pl: any) => (pl.rules ?? []).some((r: any) => r.attribute === 'customer_group_id' && groupIds.has(r.value))).map((pl: any) => pl.id))
                                    const plPrices = allPrices.filter((p: any) => applicablePLIds.has(p.price_list_id))
                                    if (plPrices.length > 0) unitPrice = Math.min(...plPrices.map((p: any) => p.amount))
                                }
                            } catch { }
                        }
                        if (unitPrice === undefined) {
                            const defaultP = allPrices.find((p: any) => !p.price_list_id && p.currency_code === "usd") ?? allPrices.find((p: any) => !p.price_list_id)
                            if (defaultP) unitPrice = defaultP.amount
                        }
                    }
                } catch { }
            }
            await fetch(`/admin/draft-orders/${id}/edit`, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" } })
            const itemPayload: any = { variant_id: variantId, quantity: 1 }
            if (unitPrice !== undefined) itemPayload.unit_price = unitPrice
            const r = await fetch(`/admin/draft-orders/${id}/edit/items`, {
                method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include",
                body: JSON.stringify({ items: [itemPayload] })
            })
            if (!r.ok) {
                const j = await r.json().catch(() => ({}))
                const msg: string = j.message ?? ""
                const needsForce = (j.type === "not_allowed" && j.code === "insufficient_inventory") || msg.toLowerCase().includes("not published") || msg.toLowerCase().includes("do not exist")
                if (needsForce) {
                    const noStockR = await fetch(`/admin/draft-orders/${id}/add-item-force`, { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include", body: JSON.stringify({ variant_id: variantId, quantity: 1, unit_price: unitPrice }) })
                    if (!noStockR.ok) { const j2 = await noStockR.json().catch(() => ({})); throw new Error(j2.message || "Could not add item") }
                } else { throw new Error(msg || `HTTP ${r.status}`) }
            }
            await fetch(`/admin/draft-orders/${id}/edit/confirm`, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" } })
            toast.success("Item added")
            try {
                const freshR = await fetch(`/admin/orders/${id}?fields=+items.*`, { credentials: "include" })
                if (freshR.ok) {
                    const { order: freshOrder } = await freshR.json()
                    const freshItems: any[] = freshOrder?.items ?? []
                    const matchedReal = freshItems.filter((i: any) => (i.variant_id ?? i.variant?.id) === variantId).sort((a: any, b: any) => new Date(b.created_at ?? 0).getTime() - new Date(a.created_at ?? 0).getTime())[0]
                    if (matchedReal) {
                        setOrder(prev => prev ? {
                            ...prev,
                            items: (prev.items ?? []).map((i: any) => i.id === optimisticItem.id
                                ? { ...matchedReal, title: optimisticItem.title, thumbnail: optimisticItem.thumbnail, variant: optimisticItem.variant, unit_price: optimisticItem.unit_price !== 0 ? optimisticItem.unit_price : matchedReal.unit_price, quantity: matchedReal.quantity ?? optimisticItem.quantity }
                                : i)
                        } : prev)
                    }
                }
            } catch { }
        } catch (e: any) {
            setOrder(prev => prev ? { ...prev, items: (prev.items ?? []).filter((i: any) => i.id !== optimisticItem.id) } : prev)
            toast.error(e.message)
        } finally { setItemSaving(false) }
    }

    // ── Update item ──────────────────────────────────────────────────────────
    const handleUpdateItem = async (itemId: string): Promise<void> => {
        setItemSaving(true)
        // Read from refs — always has the latest value even inside stale closures
        const qty = itemQtysRef.current[itemId] ?? 1
        // Fallback to current item's unit_price if user hasn't explicitly set a price
        // (prevents price from being reset to 0 when only quantity is changed)
        const currentItem = orderRef.current?.items?.find((i: any) => i.id === itemId)
        const price = parseFloat(itemPricesRef.current[itemId] ?? String(currentItem?.unit_price ?? 0))
        const prevOrder = order
        setOrder(prev => prev ? { ...prev, items: (prev.items ?? []).map((item: any) => item.id === itemId ? { ...item, quantity: qty, unit_price: price } : item) } : prev)
        try {
            const r = await fetch(`/admin/draft-orders/${id}/update-item-force`, {
                method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include",
                body: JSON.stringify({ line_item_id: itemId, quantity: qty, unit_price: price })
            })
            if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.message || `HTTP ${r.status}`) }
            toast.success("Item updated")
        } catch (e: any) { setOrder(prevOrder); toast.error(e.message) } finally { setItemSaving(false) }
    }

    // ── Remove item ──────────────────────────────────────────────────────────
    const handleRemoveItem = async (itemId: string): Promise<void> => {
        setItemSaving(true)
        try {
            const r = await fetch(`/admin/draft-orders/${id}/delete-item-force?line_item_id=${encodeURIComponent(itemId)}`, { method: "DELETE", credentials: "include", headers: { "Content-Type": "application/json" } })
            if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.message || `HTTP ${r.status}`) }
            setOrder(prev => prev ? { ...prev, items: (prev.items ?? []).filter((item: any) => item.id !== itemId) } : prev)
            toast.success("Item removed")
        } catch (e: any) { toast.error(e.message) } finally { setItemSaving(false) }
    }

    return { invQuery, invResults, itemQtys, setItemQtys: setItemQtysSafe, itemPrices, setItemPrices: setItemPricesSafe, itemSaving, searchInvItems, handleAddItem, handleUpdateItem, handleRemoveItem }
}

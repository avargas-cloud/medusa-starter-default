import { useState, useCallback, useRef, useEffect } from "react"
import { useNavigate } from "react-router-dom"
import { toast } from "@medusajs/ui"
import {
    EstimateStatus, ModalType, AddrForm, DraftOrderDetail,
    VariantResult, emptyAddr, TimelineEvent
} from "../types"

export const useDraftOrderDetail = (id: string | undefined) => {
    const navigate = useNavigate()

    const [order, setOrder] = useState<DraftOrderDetail | null>(null)
    const [loading, setLoading] = useState(true)
    const [fetchError, setFetchError] = useState<string | null>(null)
    const [timeline, setTimeline] = useState<TimelineEvent[]>([])
    const [currentUser, setCurrentUser] = useState<string>("")
    // Local-only events (e.g. Email Sent) stored in a ref so they survive setTimeline() calls from fetchOrder
    const localEventsRef = useRef<TimelineEvent[]>([])
    const [localTick, setLocalTick] = useState(0) // bumped to force re-render after adding local event


    // QB
    const [syncing, setSyncing] = useState(false)
    const [localRef, setLocalRef] = useState<string | null>(null)
    const [localTxnId, setLocalTxnId] = useState<string | null>(null)
    const [syncError, setSyncError] = useState<string | null>(null)

    // Estimate status
    const [estimateStatus, setEstimateStatus] = useState<EstimateStatus | "">("")
    const [statusSaving, setStatusSaving] = useState(false)

    // Convert
    const [converting, setConverting] = useState(false)

    // Modals
    const [modal, setModal] = useState<ModalType>(null)
    const [saving, setSaving] = useState(false)
    const [itemSaving, setItemSaving] = useState(false)
    const [itemActionMap, setItemActionMap] = useState<Record<string, string>>({})

    // Modal-specific state
    const [salesChannels, setSalesChannels] = useState<{ id: string; name: string }[]>([])
    const [selectedSc, setSelectedSc] = useState("")
    const [emailForm, setEmailForm] = useState("")
    const [shippingAddrForm, setShippingAddrForm] = useState<AddrForm>(emptyAddr())
    const [billingAddrForm, setBillingAddrForm] = useState<AddrForm>(emptyAddr())
    const [customerQuery, setCustomerQuery] = useState("")
    const [customers, setCustomers] = useState<{ id: string; first_name?: string; last_name?: string; email?: string; company_name?: string }[]>([])
    const [selectedCustomer, setSelectedCustomer] = useState("")
    const [shippingOptions, setShippingOptions] = useState<{ id: string; name: string; amount: number }[]>([])
    const [selectedOption, setSelectedOption] = useState("")
    const [customAmount, setCustomAmount] = useState("")
    const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

    // Edit items state
    const [invQuery, setInvQuery] = useState("")
    const [invResults, setInvResults] = useState<VariantResult[]>([])
    const [itemQtys, setItemQtys] = useState<Record<string, number>>({})
    const [itemPrices, setItemPrices] = useState<Record<string, string>>({})

    // Metadata state
    const [metadataForm, setMetadataForm] = useState<Record<string, string>>({})
    const [metaNewKey, setMetaNewKey] = useState("")
    const [metaNewVal, setMetaNewVal] = useState("")

    // ─── Fetch order ────────────────────────────────────────────────────────
    const fetchOrder = useCallback(async () => {
        if (!id) return
        setLoading(true); setFetchError(null)
        try {
            const [oRes, dRes] = await Promise.all([
                fetch(`/admin/orders/${id}?fields=+customer.*,+shipping_address.*,+billing_address.*,+items.*,+items.variant.*,+shipping_methods.*,+metadata,+currency_code,+email,+created_at,+display_id,+status,+sales_channel.*,+region.*`, { credentials: "include" }),
                fetch(`/admin/draft-orders/${id}`, { credentials: "include" }).then(r => r.ok ? r.json() : null).catch(() => null),
            ])
            if (!oRes.ok) throw new Error(`HTTP ${oRes.status}`)
            const json = await oRes.json()
            const rawOrder = json.order
            const preview = dRes?.order ?? dRes?.draft_order ?? null
            // /admin/draft-orders/:id returns unit_price in CENTS; /admin/orders/:id returns in DOLLARS.
            // Normalize preview items so unit_price is always in dollars.
            const normalizePrice = (cents: number) => cents > 100 ? cents / 100 : cents
            const normalizedPreviewItems = preview?.items
                ? (preview.items as any[]).map((i: any) => ({
                    ...i,
                    unit_price: normalizePrice(i.unit_price ?? 0),
                }))
                : null
            const merged = {
                ...rawOrder,
                items: normalizedPreviewItems ?? rawOrder.items ?? [],
                subtotal: preview?.subtotal != null ? preview.subtotal / 100 : rawOrder.subtotal ?? 0,
                shipping_total: preview?.shipping_total != null ? preview.shipping_total / 100 : rawOrder.shipping_total ?? 0,
                discount_total: preview?.discount_total != null ? preview.discount_total / 100 : rawOrder.discount_total ?? 0,
                tax_total: preview?.tax_total != null ? preview.tax_total / 100 : rawOrder.tax_total ?? 0,
                total: preview?.total != null ? preview.total / 100 : rawOrder.total ?? 0,
            }
            // Filter out qty-0 items (soft-deleted via delete-item-force which sets qty to 0)
            if (merged.items) {
                merged.items = merged.items.filter((item: any) => item.quantity > 0)
            }
            setOrder(merged)

            // Enrich items with thumbnail from product (batch lookup by product_id)
            try {
                const rawItems: any[] = merged.items ?? []
                const variantIds = [...new Set<string>(
                    rawItems.map((i: any) => i.variant_id ?? i.variant?.id).filter(Boolean)
                )]
                if (variantIds.length > 0) {
                    const vParams = variantIds.map(vid => `id[]=${vid}`).join("&")
                    const vRes = await fetch(`/admin/product-variants?${vParams}&limit=50`, { credentials: "include" })
                    if (vRes.ok) {
                        const { variants: vList } = await vRes.json()
                        const productIds = [...new Set<string>((vList ?? []).map((v: any) => v.product_id).filter(Boolean))]
                        const variantProductMap: Record<string, string> = {}
                            ; (vList ?? []).forEach((v: any) => { if (v.product_id) variantProductMap[v.id] = v.product_id })

                        if (productIds.length > 0) {
                            const pParams = productIds.map(pid => `id[]=${pid}`).join("&")
                            const pRes = await fetch(`/admin/products?${pParams}&limit=50`, { credentials: "include" })
                            if (pRes.ok) {
                                const { products } = await pRes.json()
                                const prodMap: Record<string, any> = {}
                                    ; (products ?? []).forEach((p: any) => { prodMap[p.id] = p })

                                merged.items = rawItems.map((item: any) => {
                                    const vid = item.variant_id ?? item.variant?.id
                                    const pid = variantProductMap[vid]
                                    const prod = prodMap[pid]
                                    return {
                                        ...item,
                                        thumbnail: item.thumbnail ?? prod?.thumbnail ?? undefined,
                                        // Ensure title = product title (not variant title)
                                        title: prod?.title ?? item.title,
                                    }
                                })
                                setOrder({ ...merged })
                            }
                        }
                    }
                }
            } catch { /* thumbnail enrichment best-effort */ }

            // Init per-item qty/price state from current order items
            const qtys: Record<string, number> = {}
            const prices: Record<string, string> = {}
            for (const item of (merged.items ?? [])) {
                qtys[item.id] = item.quantity
                prices[item.id] = String(item.unit_price ?? 0)
            }
            setItemQtys(qtys)
            setItemPrices(prices)

            const es = merged?.metadata?.estimate_status as EstimateStatus | undefined
            setEstimateStatus(es ?? "Created")
            if (!es) {
                fetch(`/admin/draft-orders/${id}`, {
                    method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include",
                    body: JSON.stringify({ metadata: { estimate_status: "Created" } })
                }).catch(() => { })
            }

            // Fetch rich activity from order changes
            try {
                const chRes = await fetch(`/admin/orders/${id}/changes`, { credentials: "include" })
                // Resolve admin user name from created_by (user ID) — best-effort cache
                const userCache: Record<string, string> = {}
                const resolveUser = async (userId?: string): Promise<string | undefined> => {
                    if (!userId) return undefined
                    if (userCache[userId]) return userCache[userId]
                    try {
                        const ur = await fetch(`/admin/users/${userId}`, { credentials: "include" })
                        if (ur.ok) {
                            const { user: u } = await ur.json()
                            const name = `${u?.first_name ?? ""} ${u?.last_name ?? ""}`.trim() || u?.email || userId
                            userCache[userId] = name
                            return name
                        }
                    } catch { }
                    return undefined
                }

                const created = { id: merged.id + "-created", created_at: merged.created_at, title: "Created", description: "Draft order created" }
                const timeline: TimelineEvent[] = [created]
                if (chRes.ok) {
                    const { order_changes } = await chRes.json()
                    for (const ch of (order_changes ?? [])) {
                        const actions: any[] = ch.actions ?? []
                        const itemAdds = actions.filter(a => /item_add|add_item/i.test(a.action ?? a.action_type ?? "")).length
                        const itemRems = actions.filter(a => /item_delete|item_remove|remove_item/i.test(a.action ?? a.action_type ?? "")).length
                        const itemAmends = actions.filter(a => /item_amend|item_update|amend_item/i.test(a.action ?? a.action_type ?? "")).length
                        const shippingAdds = actions.filter(a => /shipping_add|add_shipping/i.test(a.action ?? a.action_type ?? "")).length
                        const parts: string[] = []
                        if (itemAdds > 0) parts.push(`Added ${itemAdds} item${itemAdds > 1 ? "s" : ""}`)
                        if (itemRems > 0) parts.push(`Removed ${itemRems} item${itemRems > 1 ? "s" : ""}`)
                        if (itemAmends > 0) parts.push(`Updated ${itemAmends} item${itemAmends > 1 ? "s" : ""}`)
                        if (shippingAdds > 0) parts.push("Added shipping method")
                        if (parts.length === 0 && actions.length > 0) parts.push(`${actions.length} change${actions.length > 1 ? "s" : ""}`)
                        let title = "Order edited"
                        if (shippingAdds > 0 && itemAdds === 0 && itemRems === 0 && itemAmends === 0) title = "Shipping methods added"
                        else if (itemAdds > 0 && shippingAdds === 0 && itemRems === 0) title = "Items added"
                        else if (itemRems > 0 && itemAdds === 0 && shippingAdds === 0) title = "Items removed"
                        else if (itemAmends > 0 && itemAdds === 0 && shippingAdds === 0 && itemRems === 0) title = "Items updated"
                        if (ch.status === "pending") title += " (pending)"
                        if (parts.length > 0 || ch.status === "confirmed") {
                            // Resolve who made this change: from created_by field on the change
                            const eventUser = (await resolveUser(ch.created_by)) ?? (currentUser || undefined)
                            timeline.push({ id: ch.id, created_at: ch.created_at, title, description: parts.join(" · ") || undefined, user: eventUser })
                        }
                    }
                }
                // ── Inject "Email Sent" events from metadata (persistent across reloads) ──
                const sentAt = merged?.metadata?.estimate_sent_at as string | undefined
                const sentTo = merged?.metadata?.estimate_sent_to as string | undefined
                const sentBy = merged?.metadata?.estimate_sent_by as string | undefined
                if (sentAt) {
                    timeline.push({
                        id: `email-sent-${sentAt}`,
                        created_at: sentAt,
                        title: "Email Sent",
                        description: sentTo ? `Estimate emailed to ${sentTo}` : "Estimate emailed to customer",
                        user: sentBy || undefined,
                    })
                }
                setTimeline(timeline.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()))
            } catch { setTimeline([{ id: merged.id, created_at: merged.created_at, title: "Created", description: "Draft order created" }]) }

        } catch (e: any) { setFetchError(e.message) } finally { setLoading(false) }
    }, [id])

    useEffect(() => { fetchOrder() }, [fetchOrder])

    // ─── Fetch current logged-in user (for activity attribution) ─────────────
    useEffect(() => {
        fetch("/admin/users/me", { credentials: "include" })
            .then(r => r.ok ? r.json() : null)
            .then(data => {
                const u = data?.user
                if (u) {
                    const name = `${u.first_name ?? ""} ${u.last_name ?? ""}`.trim() || u.email || ""
                    setCurrentUser(name)
                }
            })
            .catch(() => { })
    }, [])

    // ─── Push a new event to the local timeline (no server round-trip) ────────
    // Uses a ref so the event survives any fetchOrder() call that resets server timeline state
    const addTimelineEvent = useCallback((title: string, description?: string, user?: string) => {
        const event: TimelineEvent = {
            id: `local-${Date.now()}`,
            title,
            description,
            created_at: new Date().toISOString(),
            user,
        }
        localEventsRef.current = [event, ...localEventsRef.current]
        setLocalTick(t => t + 1) // trigger re-render so OrderSidebar sees the new event
    }, [])

    // ─── Open modal ──────────────────────────────────────────────────────────
    const openModal = async (type: ModalType) => {
        setModal(type)
        if (type === "sales-channel") {
            setSelectedSc(order?.sales_channel?.id ?? "")
            const r = await fetch("/admin/sales-channels?limit=100", { credentials: "include" })
            if (r.ok) { const j = await r.json(); setSalesChannels(j.sales_channels ?? []) }
        }
        if (type === "email") setEmailForm(order?.email ?? "")
        if (type === "shipping-addr") setShippingAddrForm({
            first_name: order?.shipping_address?.first_name ?? "", last_name: order?.shipping_address?.last_name ?? "",
            company: order?.customer?.company_name ?? "", address_1: order?.shipping_address?.address_1 ?? "",
            address_2: order?.shipping_address?.address_2 ?? "", city: order?.shipping_address?.city ?? "",
            province: order?.shipping_address?.province ?? "", postal_code: order?.shipping_address?.postal_code ?? "",
            country_code: order?.shipping_address?.country_code ?? "US", phone: order?.shipping_address?.phone ?? ""
        })
        if (type === "billing-addr") setBillingAddrForm({
            first_name: order?.billing_address?.first_name ?? "", last_name: order?.billing_address?.last_name ?? "",
            company: order?.billing_address?.company ?? "", address_1: order?.billing_address?.address_1 ?? "",
            address_2: order?.billing_address?.address_2 ?? "", city: order?.billing_address?.city ?? "",
            province: order?.billing_address?.province ?? "", postal_code: order?.billing_address?.postal_code ?? "",
            country_code: order?.billing_address?.country_code ?? "US", phone: order?.billing_address?.phone ?? ""
        })
        if (type === "transfer") { setCustomerQuery(""); setCustomers([]); setSelectedCustomer("") }
        if (type === "add-shipping") {
            setShippingOptions([]); setSelectedOption(""); setCustomAmount("")
            const r = await fetch(`/admin/shipping-options`, { credentials: "include" })
            if (r.ok) { const j = await r.json(); setShippingOptions(j.shipping_options ?? []) }
        }
        if (type === "metadata") {
            const meta = order?.metadata ?? {}
            const cleaned: Record<string, string> = {}
            Object.entries(meta).forEach(([k, v]) => { if (k !== "estimate_status") cleaned[k] = String(v ?? "") })
            setMetadataForm(cleaned); setMetaNewKey(""); setMetaNewVal("")
        }
        if (type === "edit-items") {
            setInvQuery(""); setInvResults([])
            const qtys: Record<string, number> = {}
            const prices: Record<string, string> = {}
            order?.items.forEach(item => { qtys[item.id] = item.quantity; prices[item.id] = String(item.unit_price ?? 0) })
            setItemQtys(qtys); setItemPrices(prices)
            // Fetch action IDs — NO fields param, it causes 400 on some Medusa versions
            const ar = await fetch(`/admin/orders/${id}/changes`, { credentials: "include" })
            if (ar.ok) {
                const aj = await ar.json()
                const map: Record<string, string> = {}
                    ; (aj.order_changes ?? []).forEach((c: any) =>
                        (c.actions ?? []).forEach((a: any) => {
                            // NOTE: the field is 'action' (not 'action_type'), and
                            // the item id is in 'details.reference_id' (top-level reference_id is null)
                            if (a.action === "ITEM_ADD" && a.details?.reference_id && a.id) {
                                map[a.details.reference_id] = a.id
                            }
                        })
                    )
                setItemActionMap(map)
            } else {
                console.warn("[DraftOrder] Could not load order changes:", await ar.json().catch(() => ar.status))
            }
        }
    }

    const closeModal = () => setModal(null)

    // ─── PATCH draft order ────────────────────────────────────────────────────
    const patchOrder = async (body: Record<string, any>) => {
        const r = await fetch(`/admin/draft-orders/${id}`, {
            method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include", body: JSON.stringify(body)
        })
        if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.message || `HTTP ${r.status}`) }
        return r.json()
    }

    // ─── Customer search (multi-field: name, last name, email, phone) ─────────
    const searchCustomers = (q: string) => {
        setCustomerQuery(q)
        if (searchTimer.current) clearTimeout(searchTimer.current)
        searchTimer.current = setTimeout(async () => {
            if (!q.trim()) { setCustomers([]); return }
            try {
                // Split query into tokens to build individual param sets
                const tokens = q.trim().split(/\s+/)
                // Always search by generic q (email / full text)
                const params = new Set<string>()
                params.add(`q=${encodeURIComponent(q)}&limit=10`)
                // If two tokens, try first_name + last_name combo
                if (tokens.length >= 2) {
                    params.add(`first_name=${encodeURIComponent(tokens[0])}&last_name=${encodeURIComponent(tokens.slice(1).join(" "))}&limit=10`)
                    params.add(`first_name=${encodeURIComponent(tokens.slice(0, -1).join(" "))}&last_name=${encodeURIComponent(tokens[tokens.length - 1])}&limit=10`)
                }
                // Single token — try first_name, last_name, email, phone individually
                for (const tok of tokens) {
                    params.add(`first_name=${encodeURIComponent(tok)}&limit=10`)
                    params.add(`last_name=${encodeURIComponent(tok)}&limit=10`)
                    params.add(`email=${encodeURIComponent(tok)}&limit=10`)
                    params.add(`phone=${encodeURIComponent(tok)}&limit=10`)
                }
                const responses = await Promise.allSettled(
                    [...params].map(p => fetch(`/admin/customers?${p}`, { credentials: "include" }))
                )
                const seen = new Set<string>()
                const merged: typeof customers = []
                for (const res of responses) {
                    if (res.status !== "fulfilled" || !res.value.ok) continue
                    const j = await res.value.json()
                    for (const c of (j.customers ?? [])) {
                        if (!seen.has(c.id)) { seen.add(c.id); merged.push(c) }
                    }
                }
                setCustomers(merged.slice(0, 15))
            } catch { setCustomers([]) }
        }, 350)
    }


    // ─── Variant/SKU search ───────────────────────────────────────────────────
    const searchInvItems = (q: string) => {
        setInvQuery(q)
        if (searchTimer.current) clearTimeout(searchTimer.current)
        searchTimer.current = setTimeout(async () => {
            if (!q) { setInvResults([]); return }
            try {
                // /admin/product-variants supports q (matches title + SKU) + limit
                const varRes = await fetch(
                    `/admin/product-variants?q=${encodeURIComponent(q)}&limit=20`,
                    { credentials: "include" }
                )
                if (!varRes.ok) { setInvResults([]); return }

                const { variants } = await varRes.json()
                if (!variants?.length) { setInvResults([]); return }

                // 1. Enrich with product title + thumbnail
                const productIds = [...new Set<string>(
                    (variants as any[]).map((v: any) => v.product_id).filter(Boolean)
                )]
                const productMap: Record<string, any> = {}
                if (productIds.length > 0) {
                    const idParams = productIds.map((pid: string) => `id[]=${encodeURIComponent(pid)}`).join("&")
                    const pRes = await fetch(`/admin/products?${idParams}&limit=20`, { credentials: "include" })
                    if (pRes.ok) {
                        const { products } = await pRes.json()
                            ; (products ?? []).forEach((p: any) => { productMap[p.id] = p })
                    }
                }

                // 2. Enrich with customer-specific prices from our variant-prices endpoint
                let priceMap: Record<string, any> = {}
                try {
                    if (id) {
                        const vidsParam = (variants as any[]).map((v: any) => `variant_ids[]=${v.id}`).join("&")
                        const prRes = await fetch(`/admin/draft-orders/${id}/variant-prices?${vidsParam}`, { credentials: "include" })
                        if (prRes.ok) {
                            const { prices } = await prRes.json()
                            priceMap = prices ?? {}
                        }
                    }
                } catch { /* best-effort */ }

                // 3. Fetch inventory levels per location (best-effort)
                // Medusa supports filtering inventory-items by sku[], not variant_id[]
                let locationMap: Record<string, { locationName: string; available: number }[]> = {}
                try {
                    const skus = (variants as any[]).map((v: any) => v.sku).filter(Boolean)
                    if (skus.length > 0) {
                        // Pre-fetch stock locations to resolve IDs → friendly names
                        const locationNameMap: Record<string, string> = {}
                        try {
                            const slRes = await fetch(`/admin/stock-locations?limit=100`, { credentials: "include" })
                            if (slRes.ok) {
                                const { stock_locations } = await slRes.json()
                                for (const sl of (stock_locations ?? [])) {
                                    if (sl.id && sl.name) locationNameMap[sl.id] = sl.name
                                }
                            }
                        } catch { /* name resolution is best-effort */ }

                        const skuParams = skus.map((s: string) => `sku[]=${encodeURIComponent(s)}`).join("&")
                        const invRes = await fetch(`/admin/inventory-items?${skuParams}&limit=50`, { credentials: "include" })
                        if (invRes.ok) {
                            const { inventory_items } = await invRes.json()
                            // For each inventory item, fetch its location levels
                            const levelFetches = (inventory_items ?? []).map(async (inv: any) => {
                                const levRes = await fetch(
                                    `/admin/inventory-items/${inv.id}/location-levels?limit=50`,
                                    { credentials: "include" }
                                )
                                if (!levRes.ok) return
                                const { inventory_levels } = await levRes.json()
                                // Match inventory item back to variant via sku
                                const matchedVariant = (variants as any[]).find((v: any) => v.sku === inv.sku)
                                if (!matchedVariant) return
                                const vid = matchedVariant.id
                                if (!locationMap[vid]) locationMap[vid] = []
                                for (const lev of (inventory_levels ?? [])) {
                                    const locId: string = lev.location_id ?? ""
                                    const locName: string = locationNameMap[locId] ?? lev.location?.name ?? lev.stock_location?.name ?? (locId || "Warehouse")
                                    const available = (lev.stocked_quantity ?? 0) - (lev.reserved_quantity ?? 0)
                                    locationMap[vid].push({ locationName: locName, available })
                                }
                            })
                            await Promise.allSettled(levelFetches)
                        }
                    }
                } catch { /* location fetch failed — show nothing */ }

                const results: VariantResult[] = (variants as any[]).map((v: any) => {
                    const prod = productMap[v.product_id]
                    const varPrices = priceMap[v.id]
                    // Build PriceOption[] compatible array
                    // Medusa v2 REST API returns amounts already in major units (dollars)
                    const priceOptions: any[] = []
                    if (varPrices?.default) {
                        priceOptions.push({ label: "Default", amount: varPrices.default.amount })
                    }
                    for (const lp of (varPrices?.list ?? [])) {
                        const rawLabel: string = lp.price_list_name ?? "Price List"
                        const shortLabel = rawLabel.replace(/\s+Price(s)?$/i, "").trim() || rawLabel
                        priceOptions.push({ label: shortLabel, amount: lp.amount, priceListId: lp.price_list_id })
                    }
                    return {
                        id: v.id,
                        title: prod?.title ?? v.title ?? v.sku ?? v.id,
                        sku: v.sku ?? undefined,
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

    // ─── Save handlers ────────────────────────────────────────────────────────
    const handleSaveSalesChannel = async () => { setSaving(true); try { await patchOrder({ sales_channel_id: selectedSc }); toast.success("Sales channel updated"); closeModal(); fetchOrder() } catch (e: any) { toast.error(e.message) } finally { setSaving(false) } }
    const handleSaveEmail = async () => { setSaving(true); try { await patchOrder({ email: emailForm }); toast.success("Email updated"); closeModal(); fetchOrder() } catch (e: any) { toast.error(e.message) } finally { setSaving(false) } }
    const handleSaveShippingAddr = async () => { setSaving(true); try { await patchOrder({ shipping_address: shippingAddrForm }); toast.success("Shipping address updated"); closeModal(); fetchOrder() } catch (e: any) { toast.error(e.message) } finally { setSaving(false) } }
    const handleSaveBillingAddr = async () => { setSaving(true); try { await patchOrder({ billing_address: billingAddrForm }); toast.success("Billing address updated"); closeModal(); fetchOrder() } catch (e: any) { toast.error(e.message) } finally { setSaving(false) } }

    const handleTransfer = async (): Promise<void> => {
        if (!selectedCustomer) { toast.error("Select a customer first"); return }
        setSaving(true)
        try { await patchOrder({ customer_id: selectedCustomer }); toast.success("Ownership transferred"); closeModal(); fetchOrder() } catch (e: any) { toast.error(e.message) } finally { setSaving(false) }
    }

    const handleAddItem = async (variantId: string, overridePrice?: number): Promise<void> => {
        setItemSaving(true)
        // ── Find the variant info from current search results for optimistic update
        const matchedVariant = invResults.find(v => v.id === variantId)
        const optimisticItem = {
            id: `optimistic-${Date.now()}`,
            variant_id: variantId,
            variant: { id: variantId, sku: matchedVariant?.sku ?? "" },
            title: matchedVariant?.title ?? variantId,
            subtitle: matchedVariant?.variantTitle ?? "",
            thumbnail: matchedVariant?.thumbnail ?? null,
            quantity: 1,
            unit_price: overridePrice !== undefined ? overridePrice : 0,
        }
        // ── Optimistic: show item immediately in the list
        setOrder(prev => prev ? { ...prev, items: [...(prev.items ?? []), optimisticItem as any] } : prev)
        setInvQuery(""); setInvResults([])
        try {
            // 1. Resolve price: overridePrice > price list price > default variant price
            let unitPrice: number | undefined = overridePrice
            if (unitPrice === undefined) {
                try {
                    const varRes = await fetch(`/admin/product-variants/${variantId}?fields=*prices`, { credentials: "include" })
                    if (varRes.ok) {
                        const { variant } = await varRes.json()
                        const allPrices: any[] = variant?.prices ?? []

                        // Try customer price list first
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
                                    const applicablePLIds = new Set(
                                        (price_lists ?? []).filter((pl: any) =>
                                            (pl.rules ?? []).some((r: any) => r.attribute === 'customer_group_id' && groupIds.has(r.value))
                                        ).map((pl: any) => pl.id)
                                    )
                                    const plPrices = allPrices.filter((p: any) => applicablePLIds.has(p.price_list_id))
                                    if (plPrices.length > 0) {
                                        // REST API returns amounts in dollars (Medusa v2 major units)
                                        unitPrice = Math.min(...plPrices.map((p: any) => p.amount))
                                    }
                                }
                            } catch { /* price list lookup failed, fall through to default */ }
                        }

                        // Fallback: use default price (no price_list_id) to avoid $0
                        if (unitPrice === undefined) {
                            const defaultP = allPrices.find((p: any) => !p.price_list_id && p.currency_code === "usd")
                                ?? allPrices.find((p: any) => !p.price_list_id)
                            // REST API returns amounts in dollars (no /100 needed)
                            if (defaultP) unitPrice = defaultP.amount
                        }
                    }
                } catch { /* best-effort — leave unitPrice undefined */ }
            }

            // 2. Start/ensure an active edit session
            await fetch(`/admin/draft-orders/${id}/edit`, {
                method: "POST", credentials: "include",
                headers: { "Content-Type": "application/json" }
            })
            // 3. Add item
            const itemPayload: any = { variant_id: variantId, quantity: 1 }
            if (unitPrice !== undefined) itemPayload.unit_price = unitPrice
            const r = await fetch(`/admin/draft-orders/${id}/edit/items`, {
                method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include",
                body: JSON.stringify({ items: [itemPayload] })
            })
            if (!r.ok) {
                const j = await r.json().catch(() => ({}))
                const msg: string = j.message ?? ""
                const needsForce =
                    (j.type === "not_allowed" && j.code === "insufficient_inventory") ||
                    msg.toLowerCase().includes("not published") ||
                    msg.toLowerCase().includes("do not exist")
                if (needsForce) {
                    const noStockR = await fetch(`/admin/draft-orders/${id}/add-item-force`, {
                        method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include",
                        body: JSON.stringify({ variant_id: variantId, quantity: 1, unit_price: unitPrice })
                    })
                    if (!noStockR.ok) { const j2 = await noStockR.json().catch(() => ({})); throw new Error(j2.message || "Could not add item") }
                } else {
                    throw new Error(msg || `HTTP ${r.status}`)
                }
            }
            // 4. Confirm to persist
            await fetch(`/admin/draft-orders/${id}/edit/confirm`, {
                method: "POST", credentials: "include",
                headers: { "Content-Type": "application/json" }
            })
            toast.success("Item added")
            // ── Patch real ID in place: fetch the order silently and replace the optimistic item
            // Keep enriched data (title, thumbnail, unit_price in dollars) from the optimistic item —
            // the raw API response has title = variant_id and unit_price in cents, which we don't want.
            try {
                const freshR = await fetch(`/admin/orders/${id}?fields=+items.*`, { credentials: "include" })
                if (freshR.ok) {
                    const { order: freshOrder } = await freshR.json()
                    const freshItems: any[] = freshOrder?.items ?? []
                    // Find the newest item (highest created_at that matches this variant)
                    const matchedReal = freshItems
                        .filter((i: any) => (i.variant_id ?? i.variant?.id) === variantId)
                        .sort((a: any, b: any) => new Date(b.created_at ?? 0).getTime() - new Date(a.created_at ?? 0).getTime())[0]
                    if (matchedReal) {
                        setOrder(prev => prev ? {
                            ...prev,
                            items: (prev.items ?? []).map((i: any) =>
                                i.id === optimisticItem.id
                                    ? {
                                        // Merge real metadata (id, created_at, etc) from API
                                        ...matchedReal,
                                        // But preserve the enriched display data from the optimistic item
                                        title: optimisticItem.title,
                                        thumbnail: optimisticItem.thumbnail,
                                        variant: optimisticItem.variant,
                                        // unit_price: optimistic already has it in dollars (computed above)
                                        // matchedReal.unit_price may be in cents from the raw API
                                        unit_price: optimisticItem.unit_price !== 0
                                            ? optimisticItem.unit_price
                                            : matchedReal.unit_price,
                                        quantity: matchedReal.quantity ?? optimisticItem.quantity,
                                    }
                                    : i
                            )
                        } : prev)
                    }
                }
            } catch { /* ID patch failed — no action, optimistic item stays */ }
        } catch (e: any) {
            // Revert optimistic item on failure
            setOrder(prev => prev ? { ...prev, items: (prev.items ?? []).filter((i: any) => i.id !== optimisticItem.id) } : prev)
            toast.error(e.message)
        } finally { setItemSaving(false) }
    }

    const handleUpdateItem = async (itemId: string): Promise<void> => {
        setItemSaving(true)
        const qty = itemQtys[itemId] ?? 1
        const price = parseFloat(itemPrices[itemId] ?? "0")
        // Optimistic FIRST: update local item qty + price immediately — no wait
        const prevOrder = order  // save snapshot for rollback
        setOrder(prev => {
            if (!prev) return prev
            return {
                ...prev,
                items: (prev.items ?? []).map((item: any) =>
                    item.id === itemId
                        ? { ...item, quantity: qty, unit_price: price }  // unit_price in dollars
                        : item
                )
            }
        })
        try {
            // 1. Start/ensure an active edit session
            await fetch(`/admin/draft-orders/${id}/edit`, {
                method: "POST", credentials: "include",
                headers: { "Content-Type": "application/json" }
            })
            // API expects unit_price in dollars (Medusa v2 order API uses decimal major unit)
            const r = await fetch(`/admin/draft-orders/${id}/edit/items/item/${itemId}`, {
                method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include",
                body: JSON.stringify({ quantity: qty, unit_price: price })
            })
            if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.message || `HTTP ${r.status}`) }
            // 3. Confirm to persist
            await fetch(`/admin/draft-orders/${id}/edit/confirm`, {
                method: "POST", credentials: "include",
                headers: { "Content-Type": "application/json" }
            })
            toast.success("Item updated")
        } catch (e: any) {
            // Rollback on failure
            setOrder(prevOrder)
            toast.error(e.message)
        } finally { setItemSaving(false) }
    }

    const handleRemoveItem = async (itemId: string): Promise<void> => {
        setItemSaving(true)
        try {
            // Pass line_item_id as query param — more reliable than DELETE body
            // (some Express/Medusa configs skip body parsing on DELETE requests)
            const url = `/admin/draft-orders/${id}/delete-item-force?line_item_id=${encodeURIComponent(itemId)}`
            const r = await fetch(url, {
                method: "DELETE", credentials: "include",
                headers: { "Content-Type": "application/json" },
            })
            if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.message || `HTTP ${r.status}`) }
            // Optimistic: remove item instantly — no re-fetch needed
            setOrder(prev => {
                if (!prev) return prev
                return { ...prev, items: (prev.items ?? []).filter((item: any) => item.id !== itemId) }
            })
            toast.success("Item removed")
        } catch (e: any) { toast.error(e.message) } finally { setItemSaving(false) }
    }


    const handleAddShipping = async (optionId?: string, customAmountStr?: string): Promise<void> => {
        // Accept direct params (called from InlineShipping) or fall back to state (called from modal)
        const resolvedOption = optionId ?? selectedOption
        const resolvedAmount = customAmountStr !== undefined ? customAmountStr : customAmount
        if (!resolvedOption) { toast.error("Select a shipping option"); return }
        setSaving(true)
        try {
            const body: Record<string, any> = { shipping_option_id: resolvedOption }
            const parsedCustom = resolvedAmount ? parseFloat(resolvedAmount) : NaN
            if (!isNaN(parsedCustom) && parsedCustom >= 0) body.custom_amount = parsedCustom
            const r = await fetch(`/admin/draft-orders/${id}/add-shipping-force`, {
                method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include", body: JSON.stringify(body)
            })
            if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.message || `HTTP ${r.status}`) }



            toast.success("Shipping method added"); closeModal()

            // Optimistic: fetch shipping option name/amount then update local state instantly
            const shippingOptRes = await fetch(`/admin/shipping-options/${resolvedOption}`, { credentials: "include" }).catch(() => null)
            if (shippingOptRes?.ok) {
                const { shipping_option } = await shippingOptRes.json()
                const optName: string = (shipping_option?.name ?? "").toLowerCase()
                const isPickup = optName.includes("pickup") || optName.includes("store")
                const newAmount = !isNaN(parsedCustom) && parsedCustom >= 0
                    ? parsedCustom
                    : (shipping_option?.amount ?? 0)

                setOrder(prev => {
                    if (!prev) return prev
                    return {
                        ...prev,
                        shipping_methods: [
                            ...(prev.shipping_methods ?? []),
                            { id: `optimistic-${Date.now()}`, name: shipping_option?.name ?? "Shipping", amount: newAmount, data: {} },
                        ],
                        shipping_total: (prev.shipping_total ?? 0) + newAmount,
                    }
                })

                const isWarehouseOrPickup = isPickup || optName.includes("warehouse")
                if (isWarehouseOrPickup) {
                    // Fetch stock location address from DB and auto-populate shipping address
                    ; (async () => {
                        try {
                            const fallbackAddr = { first_name: "Ecopowertech", last_name: "Inc", company: "Ecopowertech Inc", address_1: "2760 W 84th St", address_2: "Unit 4", city: "Hialeah", province: "FL", postal_code: "33016", country_code: "us", phone: "" }
                            let addr = fallbackAddr
                            try {
                                const slRes = await fetch(`/admin/stock-locations?limit=100&fields=*,+address.*`, { credentials: "include" })
                                if (slRes.ok) {
                                    const { stock_locations } = await slRes.json()
                                    // Find best-matching location by name similarity with shipping option
                                    const words = optName.split(/\s+/).filter((w: string) => w.length > 2)
                                    const match = (stock_locations ?? []).find((sl: any) =>
                                        words.some((w: string) => (sl.name ?? "").toLowerCase().includes(w))
                                    ) ?? (stock_locations ?? [])[0]
                                    if (match?.address) {
                                        const a = match.address
                                        addr = {
                                            first_name: "Ecopowertech",
                                            last_name: "Inc",
                                            company: a.company || match.name || "Ecopowertech Inc",
                                            address_1: a.address_1 ?? fallbackAddr.address_1,
                                            address_2: a.address_2 ?? fallbackAddr.address_2,
                                            city: a.city ?? fallbackAddr.city,
                                            province: a.province_code ?? a.province ?? fallbackAddr.province,
                                            postal_code: a.postal_code ?? fallbackAddr.postal_code,
                                            country_code: (a.country_code ?? "us").toLowerCase(),
                                            phone: a.phone ?? "",
                                        }
                                    }
                                }
                            } catch { /* use fallback */ }
                            await fetch(`/admin/draft-orders/${id}`, {
                                method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include",
                                body: JSON.stringify({ shipping_address: addr }),
                            })
                            fetchOrder() // Refresh to show updated address in CustomerBlock
                        } catch (e) { console.warn("[warehouse/pickup] address update failed:", e) }
                    })()
                }
                // Silent background sync after 2s — only patches real shipping method IDs into state
                // Does NOT call fetchOrder (no re-render) — just swaps the optimistic ID for the real one
                setTimeout(async () => {
                    try {
                        const freshR = await fetch(`/admin/orders/${id}?fields=+shipping_methods.*`, { credentials: "include" })
                        if (freshR.ok) {
                            const { order: freshOrder } = await freshR.json()
                            const freshMethods: any[] = freshOrder?.shipping_methods ?? []
                            if (freshMethods.length > 0) {
                                setOrder(prev => prev ? { ...prev, shipping_methods: freshMethods } : prev)
                            }
                        }
                    } catch { /* ID patch failed */ }
                }, 1500)
            }
        } catch (e: any) { toast.error(e.message) } finally { setSaving(false) }
    }

    const handleRemoveShipping = (methodId: string) => {
        // Optimistically remove the shipping method from local state
        setOrder(prev => {
            if (!prev) return prev
            const removed = (prev.shipping_methods ?? []).find((m: any) => m.id === methodId)
            const removedAmount = removed?.amount ?? 0
            return {
                ...prev,
                shipping_methods: (prev.shipping_methods ?? []).filter((m: any) => m.id !== methodId),
                shipping_total: Math.max(0, (prev.shipping_total ?? 0) - removedAmount),
            }
        })
    }


    const handleSaveMetadata = async (): Promise<void> => {
        setSaving(true)
        try {
            const existing = order?.metadata ?? {}
            const updated = { ...existing, ...metadataForm }
            Object.keys(existing).forEach(k => { if (k !== "estimate_status" && !(k in metadataForm)) updated[k] = null })
            await patchOrder({ metadata: updated })
            toast.success("Metadata updated"); closeModal(); fetchOrder()
        } catch (e: any) { toast.error(e.message) } finally { setSaving(false) }
    }

    const handleDelete = async () => {
        if (!id || !confirm("Delete this draft order? This cannot be undone.")) return
        try {
            const r = await fetch(`/admin/draft-orders/${id}`, { method: "DELETE", credentials: "include" })
            if (!r.ok) throw new Error(`HTTP ${r.status}`)
            toast.success("Deleted"); navigate("/draft-orders-advanced")
        } catch (e: any) { toast.error(e.message) }
    }

    const handleConvert = async () => {
        // Note: window.confirm() can be silently suppressed by Chrome in some contexts.
        // Using toast-based confirmation instead for reliability.
        const toastId = toast.loading(
            "Converting to order… (Items with 0 stock will be accepted as backorders)"
        )
        setConverting(true)
        try {
            const r = await fetch(`/admin/draft-orders/${id}/convert-force`, {
                method: "POST",
                credentials: "include",
                headers: { "Content-Type": "application/json" },
            })
            const j = await r.json()
            if (!r.ok) throw new Error(j.message || `HTTP ${r.status}: ${r.statusText}`)

            const orderId = j.order?.id ?? id
            toast.dismiss(toastId)
            if (j.backorder_items_enabled) {
                toast.success("Converted to order! Some items are on backorder.")
            } else {
                toast.success("Converted to order! Redirecting…")
            }
            navigate(`/orders/${orderId}`)
        } catch (e: any) {
            toast.dismiss(toastId)
            toast.error(`Convert failed: ${e.message}`)
        } finally { setConverting(false) }
    }

    const handleStatusChange = async (val: string) => {
        setStatusSaving(true)
        try { await patchOrder({ metadata: { estimate_status: val } }); setEstimateStatus(val as EstimateStatus); toast.success(`Status → "${val}"`) } catch (e: any) { toast.error(e.message) } finally { setStatusSaving(false) }
    }

    const handleSync = async () => {
        if (!order) return; setSyncing(true); setSyncError(null)
        try {
            const r = await fetch("/admin/quickbooks/draft-order", {
                method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include",
                body: JSON.stringify({ orderId: order.id })
            })
            const j = await r.json()
            if (j.success) { if (j.qbEstimateTxnId) { setLocalTxnId(j.qbEstimateTxnId); setLocalRef(j.qbEstimateRef ?? j.qbEstimateTxnId) }; toast.success(j.message || "Saved to QuickBooks!") }
            else { setSyncError(j.error || "Sync failed"); toast.error(j.error || "Sync failed") }
        } catch (e: any) { setSyncError(e.message); toast.error(e.message) } finally { setSyncing(false) }
    }

    const handleAddMetaKey = () => {
        if (metaNewKey.trim()) {
            setMetadataForm(m => ({ ...m, [metaNewKey.trim()]: metaNewVal }))
            setMetaNewKey(""); setMetaNewVal("")
        }
    }

    return {
        // Order data — timeline is merged: local events (ref) + server events (state), newest first
        order, loading, fetchError, fetchOrder,
        // localTick drives re-render whenever addTimelineEvent fires so localEventsRef.current is picked up
        timeline: (localTick >= 0 ? [...localEventsRef.current, ...timeline] : timeline).sort(
            (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
        ),
        currentUser, addTimelineEvent,
        // QB state
        syncing, localRef, localTxnId, syncError,
        // Estimate status
        estimateStatus, statusSaving,
        // Convert
        converting,
        // Modal state
        modal, saving, itemSaving, itemActionMap,
        salesChannels, selectedSc, setSelectedSc,
        emailForm, setEmailForm,
        shippingAddrForm, setShippingAddrForm,
        billingAddrForm, setBillingAddrForm,
        customerQuery, customers, selectedCustomer, setSelectedCustomer,
        shippingOptions, selectedOption, setSelectedOption,
        customAmount, setCustomAmount,
        invQuery, invResults,
        itemQtys, setItemQtys, itemPrices, setItemPrices,
        metadataForm, setMetadataForm,
        metaNewKey, setMetaNewKey,
        metaNewVal, setMetaNewVal,
        // Actions
        openModal, closeModal,
        searchCustomers, searchInvItems,
        handleSaveSalesChannel, handleSaveEmail, handleSaveShippingAddr, handleSaveBillingAddr,
        handleTransfer, handleAddItem, handleUpdateItem, handleRemoveItem,
        handleAddShipping, handleRemoveShipping, handleSaveMetadata,
        handleDelete, handleConvert, handleStatusChange, handleSync, handleAddMetaKey,
    }
}

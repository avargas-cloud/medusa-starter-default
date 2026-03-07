import { useState, useEffect, useMemo } from "react"
import { useNavigate } from "react-router-dom"

// ─── Types ────────────────────────────────────────────────────────────────────

export type FulfillmentFilter = "not_fulfilled" | "partially_fulfilled" | "fulfilled" | "delivered"

export interface OrderListItem {
    id: string
    display_id: number
    status: string
    fulfillment_status: string
    payment_status: string
    total: number
    currency_code: string
    created_at: string
    metadata?: Record<string, unknown>
    customer?: { first_name?: string; last_name?: string; email?: string; company_name?: string; phone?: string }
    shipping_address?: { first_name?: string; last_name?: string; company?: string; phone?: string }
    sales_channel?: { name?: string }
}

export type SortKey = "display_id_desc" | "display_id_asc" | "created_at_desc" | "created_at_asc" | "total_desc" | "total_asc"

export const SORT_OPTIONS: { value: SortKey; label: string }[] = [
    { value: "display_id_desc", label: "# (Newest first)" },
    { value: "display_id_asc", label: "# (Oldest first)" },
    { value: "created_at_desc", label: "Date (Newest)" },
    { value: "created_at_asc", label: "Date (Oldest)" },
    { value: "total_desc", label: "Total (High → Low)" },
    { value: "total_asc", label: "Total (Low → High)" },
]

export const PAGE_SIZE = 20

// ─── Hook ─────────────────────────────────────────────────────────────────────

/**
 * Generic orders list hook — fetches from /admin/orders and filters by
 * fulfillment_status values. Provide one or more statuses to include.
 *
 * Sales Orders  → fulfillmentFilters: ["not_fulfilled", "partially_fulfilled"]
 * Invoices      → fulfillmentFilters: ["fulfilled"]
 */
export const useOrdersList = (fulfillmentFilters: FulfillmentFilter[]) => {
    const navigate = useNavigate()
    const [orders, setOrders] = useState<OrderListItem[]>([])
    const [loading, setLoading] = useState(true)
    const [search, setSearch] = useState("")
    const [sort, setSort] = useState<SortKey>("display_id_desc")
    const [page, setPage] = useState(0)
    const [showCancelled, setShowCancelled] = useState(false)

    useEffect(() => {
        const load = async () => {
            setLoading(true)
            try {
                // Fetch all orders — filter client-side (same pattern as draft-orders-advanced)
                const params = new URLSearchParams({
                    limit: "250",
                    fields: "id,display_id,status,fulfillment_status,payment_status,total,currency_code,created_at,+metadata,+customer.first_name,+customer.last_name,+customer.email,+customer.phone,+customer.company_name,+shipping_address.first_name,+shipping_address.last_name,+shipping_address.phone,+shipping_address.company,+sales_channel.name",
                })
                const r = await fetch(`/admin/orders?${params}`, { credentials: "include" })
                if (r.ok) {
                    const json = await r.json()
                    setOrders(json.orders ?? [])
                }
            } catch (err) {
                console.error("[useOrdersList] fetch failed", err)
            } finally {
                setLoading(false)
            }
        }
        load()
    }, [])

    // Count cancelled orders (status field, not fulfillment_status)
    const cancelledCount = useMemo(() =>
        orders.filter(o => o.status === "canceled").length,
        [orders]
    )

    // Client-side filter by fulfillment_status, then hide cancelled unless toggled
    const fulfillmentFiltered = useMemo(() =>
        orders
            .filter(o => fulfillmentFilters.includes(o.fulfillment_status as any))
            .filter(o => showCancelled || o.status !== "canceled"),
        [orders, fulfillmentFilters.join(","), showCancelled]
    )

    const filtered = useMemo(() => {
        if (!search.trim()) return fulfillmentFiltered
        const q = search.toLowerCase().replace(/[^\d]/g, "") || search.toLowerCase()
        const isPhoneSearch = /^[\d\s\-()]+$/.test(search.trim())
        return fulfillmentFiltered.filter(o => {
            const firstName = o.customer?.first_name ?? o.shipping_address?.first_name ?? ""
            const lastName = o.customer?.last_name ?? o.shipping_address?.last_name ?? ""
            const company = o.customer?.company_name ?? o.shipping_address?.company ?? ""
            const email = o.customer?.email ?? ""
            const phone = (o.customer?.phone ?? o.shipping_address?.phone ?? "").replace(/[^\d]/g, "")
            const name = `${firstName} ${lastName}`.trim().toLowerCase()
            if (isPhoneSearch) {
                return phone.includes(q) || name.includes(search.toLowerCase()) || `#${o.display_id}`.includes(search.toLowerCase())
            }
            return (
                name.includes(search.toLowerCase()) ||
                email.toLowerCase().includes(search.toLowerCase()) ||
                company.toLowerCase().includes(search.toLowerCase()) ||
                phone.includes(search.replace(/[^\d]/g, "")) ||
                `#${o.display_id}`.includes(search.toLowerCase())
            )
        })
    }, [fulfillmentFiltered, search])

    const sorted = useMemo(() => {
        const arr = [...filtered]
        switch (sort) {
            case "display_id_desc": return arr.sort((a, b) => b.display_id - a.display_id)
            case "display_id_asc": return arr.sort((a, b) => a.display_id - b.display_id)
            case "created_at_desc": return arr.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
            case "created_at_asc": return arr.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
            case "total_desc": return arr.sort((a, b) => (b.total ?? 0) - (a.total ?? 0))
            case "total_asc": return arr.sort((a, b) => (a.total ?? 0) - (b.total ?? 0))
        }
    }, [filtered, sort])

    const totalPages = Math.ceil(sorted.length / PAGE_SIZE)
    const paginated = sorted.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)

    return {
        navigate,
        orders, loading,
        search, setSearch,
        sort, setSort,
        page, setPage,
        filtered, sorted, paginated,
        totalPages,
        showCancelled, setShowCancelled,
        cancelledCount,
    }
}

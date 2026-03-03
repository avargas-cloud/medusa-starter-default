import { useState, useEffect, useMemo } from "react"
import { useNavigate } from "react-router-dom"

export interface DraftOrderListItem {
    id: string
    display_id: number
    status: string
    email?: string
    currency_code?: string
    total?: number
    created_at: string
    metadata?: Record<string, any>
    customer?: { first_name?: string; last_name?: string; email?: string; company_name?: string }
    sales_channel?: { name?: string }
    region?: { name?: string }
}

export type SortKey = "display_id_desc" | "display_id_asc" | "created_at_desc" | "created_at_asc"

export const SORT_OPTIONS: { value: SortKey; label: string }[] = [
    { value: "display_id_desc", label: "# (Newest first)" },
    { value: "display_id_asc", label: "# (Oldest first)" },
    { value: "created_at_desc", label: "Date (Newest)" },
    { value: "created_at_asc", label: "Date (Oldest)" },
]

export const PAGE_SIZE = 20

export const useDraftOrders = () => {
    const navigate = useNavigate()
    const [orders, setOrders] = useState<DraftOrderListItem[]>([])
    const [loading, setLoading] = useState(true)
    const [search, setSearch] = useState("")
    const [sort, setSort] = useState<SortKey>("display_id_desc")
    const [page, setPage] = useState(0)

    useEffect(() => {
        const load = async () => {
            setLoading(true)
            try {
                const resp = await fetch(
                    `/admin/draft-orders?limit=250&fields=id,display_id,status,email,currency_code,total,created_at,metadata,+customer.first_name,+customer.last_name,+customer.email,+customer.company_name,+sales_channel.name`,
                    { credentials: "include" }
                )
                const json = await resp.json()
                setOrders(json.draft_orders ?? [])
            } catch (err) {
                console.error("Failed to fetch draft orders", err)
            } finally {
                setLoading(false)
            }
        }
        load()
    }, [])

    const filtered = useMemo(() => {
        if (!search.trim()) return orders
        const q = search.toLowerCase()
        return orders.filter(o => {
            const name = `${o.customer?.first_name ?? ""} ${o.customer?.last_name ?? ""}`.trim().toLowerCase()
            const email = (o.customer?.email ?? o.email ?? "").toLowerCase()
            return name.includes(q) || email.includes(q) || `#${o.display_id}`.includes(q)
        })
    }, [orders, search])

    const sorted = useMemo(() => {
        const arr = [...filtered]
        switch (sort) {
            case "display_id_desc": return arr.sort((a, b) => b.display_id - a.display_id)
            case "display_id_asc": return arr.sort((a, b) => a.display_id - b.display_id)
            case "created_at_desc": return arr.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
            case "created_at_asc": return arr.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
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
    }
}

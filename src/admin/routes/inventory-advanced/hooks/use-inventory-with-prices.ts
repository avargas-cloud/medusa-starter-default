import { useQuery } from "@tanstack/react-query"
import { useState, useMemo } from "react"

export interface InventoryItemWithPrice {
    id: string
    sku: string
    title?: string
    totalStock: number
    totalReserved: number
    price?: {
        amount: number
        currencyCode: string
    }
    variantId?: string
    productId?: string
    productCategoryId?: string // NEW: for category filtering
}

/**
 * Hook: Inventory Data with Prices
 * 
 * Uses custom backend endpoint /admin/inventory/with-prices
 * for optimized data fetching with a single query
 * 
 * NEW: Added sorting and category filtering functionality
 */
export const useInventoryWithPrices = () => {
    const [searchQuery, setSearchQuery] = useState("")
    const [currentPage, setCurrentPage] = useState(0)
    const [sortBy, setSortBy] = useState<string>("title:asc")
    const [categoryFilter, setCategoryFilter] = useState<string | null>(null)
    const itemsPerPage = 20

    const { data, isLoading, error, refetch } = useQuery({
        queryKey: ["custom-inventory-with-prices"],
        queryFn: async () => {
            const response = await fetch("/admin/inventory/with-prices", {
                credentials: "include",
                headers: {
                    "Content-Type": "application/json"
                }
            })

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`)
            }

            const data = await response.json()
            // console.log("✅ Inventory items loaded:", data.items.length)
            // console.log("💰 Sample item with price:", data.items.find((i: any) => i.price))

            return data.items as InventoryItemWithPrice[]
        }
    })

    const allItems = data || []

    // Filter by search query
    const searchFilteredItems = allItems.filter((item) => {
        if (!searchQuery) return true
        const query = searchQuery.toLowerCase()
        return (
            item.sku.toLowerCase().includes(query) ||
            item.title?.toLowerCase().includes(query)
        )
    })

    // Filter by category
    const categoryFilteredItems = searchFilteredItems.filter((item) => {
        if (!categoryFilter || categoryFilter === "all") return true
        return item.productCategoryId === categoryFilter
    })

    // Sorting
    const sortedItems = useMemo(() => {
        const [field, direction] = sortBy.split(":") as [string, "asc" | "desc"]

        return [...categoryFilteredItems].sort((a, b) => {
            let aValue: any
            let bValue: any

            switch (field) {
                case "sku":
                    aValue = a.sku || ""
                    bValue = b.sku || ""
                    break
                case "title":
                    aValue = a.title || ""
                    bValue = b.title || ""
                    break
                case "stock":
                    aValue = a.totalStock
                    bValue = b.totalStock
                    break
                default:
                    return 0
            }

            // String comparison
            if (typeof aValue === "string") {
                const comparison = aValue.localeCompare(bValue)
                return direction === "asc" ? comparison : -comparison
            }

            // Number comparison
            return direction === "asc" ? aValue - bValue : bValue - aValue
        })
    }, [categoryFilteredItems, sortBy])

    // Pagination
    const totalPages = Math.ceil(sortedItems.length / itemsPerPage)
    const paginatedItems = sortedItems.slice(
        currentPage * itemsPerPage,
        (currentPage + 1) * itemsPerPage
    )

    return {
        items: paginatedItems,
        isLoading,
        error,
        refetch,
        searchQuery,
        setSearchQuery,
        currentPage,
        setCurrentPage,
        totalPages,
        totalItems: sortedItems.length,
        itemsPerPage,
        sortBy,
        setSortBy,
        categoryFilter,
        setCategoryFilter,
    }
}

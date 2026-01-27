import { Container, Toaster } from "@medusajs/ui"
import { useInventorySearch } from "./hooks/use-inventory-search"
import { useCategories } from "./hooks/use-categories"
import { InventoryHeader } from "./components/inventory-header"
import { InventoryTable } from "./components/inventory-table"
import { InventoryPagination } from "./components/inventory-pagination"
import { useState } from "react"

/**
 * Advanced Inventory Page
 * 
 * NOW POWERED BY MEILISEARCH for ultra-fast search and filtering
 * Delegates logic to hooks and rendering to components
 */
const InventoryPage = () => {
    const [searchQuery, setSearchQuery] = useState("")
    const [currentPage, setCurrentPage] = useState(0)
    const [sortBy, setSortBy] = useState<string>("title:asc")
    const [categoryFilter, setCategoryFilter] = useState<string | null>(null)

    const { categories, isLoading: isLoadingCategories } = useCategories()

    // MeiliSearch hook
    const {
        data,
        isLoading,
        refetch,
        ITEMS_PER_PAGE
    } = useInventorySearch({
        searchQuery,
        sortBy,
        categoryFilter,
        currentPage
    })

    const items = data?.hits || []
    const totalHits = data?.totalHits || 0
    const totalPages = Math.ceil(totalHits / ITEMS_PER_PAGE)

    const handleSearchChange = (value: string) => {
        setSearchQuery(value)
        setCurrentPage(0) // Reset to first page on search
    }

    const handleCategoryChange = (category: string) => {
        setCategoryFilter(category === "all" ? null : category)
        setCurrentPage(0)
    }

    const handleSortChange = (sort: string) => {
        setSortBy(sort)
        setCurrentPage(0)
    }

    return (
        <>
            <Toaster />
            <Container className="divide-y p-0 h-full flex flex-col overflow-hidden">
                <InventoryHeader
                    searchQuery={searchQuery}
                    onSearchChange={handleSearchChange}
                    onRefresh={refetch}
                    categoryFilter={categoryFilter || "all"}
                    onCategoryChange={handleCategoryChange}
                    categories={categories}
                    isLoadingCategories={isLoadingCategories}
                    sortBy={sortBy}
                    onSortChange={handleSortChange}
                    totalItems={totalHits}
                />
                <InventoryTable
                    items={items}
                    isLoading={isLoading}
                    sortBy={sortBy}
                    onSortChange={handleSortChange}
                />
                <InventoryPagination
                    currentPage={currentPage}
                    totalPages={totalPages}
                    onPageChange={setCurrentPage}
                    totalItems={totalHits}
                    itemsPerPage={ITEMS_PER_PAGE}
                />
            </Container>
        </>
    )
}

export default InventoryPage

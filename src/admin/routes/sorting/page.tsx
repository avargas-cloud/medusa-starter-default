import { defineRouteConfig } from "@medusajs/admin-sdk"
import { Container, Heading, Button } from "@medusajs/ui"
import { ListTree } from "@medusajs/icons"
import { useState, useEffect } from "react"
import { useSearchParams } from "react-router-dom"
import { useSortingData } from "../../hooks/useSortingData"
import { useCategorySorting } from "../../hooks/useCategorySorting"
import { CategorySelector } from "../../components/sorting/CategorySelector"
import { SubcategoriesList } from "../../components/sorting/SubcategoriesList"
import { ProductsList } from "../../components/sorting/ProductsList"

/**
 * Main Sorting Admin Page
 * 
 * 3-panel layout:
 * - Left: Category selector (tree view)
 * - Middle: Subcategories drag-and-drop list
 * - Right: Products drag-and-drop list
 */
export const SortingPage = () => {
    const [searchParams] = useSearchParams()
    const initialCategoryId = searchParams.get("category_id")
    const [selectedCategoryId, setSelectedCategoryId] = useState<string | undefined>(initialCategoryId || undefined)

    // Update selected category if URL param changes (optional, but good for deep linking)
    useEffect(() => {
        const paramId = searchParams.get("category_id")
        if (paramId) {
            setSelectedCategoryId(paramId)
        }
    }, [searchParams])

    const { categories, subcategories, products, isLoading } = useSortingData(selectedCategoryId)

    // Get current sorting config from selected category
    const selectedCategory = categories.find((c) => c.id === selectedCategoryId)
    const currentConfig = selectedCategory?.metadata?.sorting_config

    // Debug: Log current config when it changes
    useEffect(() => {
        if (selectedCategoryId) {
            // console.log("[Sorting Debug] Category:", selectedCategory?.name)
            // console.log("[Sorting Debug] Current Config:", currentConfig)
        }
    }, [selectedCategoryId, currentConfig])

    // Initialize sorting state
    const {
        subcategoryOrder,
        setSubcategoryOrder,
        productOrder,
        setProductOrder,
        saveSorting,
        isSaving,
        hasChanges,
    } = useCategorySorting(selectedCategoryId, currentConfig)

    // Update order arrays when category changes or data loads
    useEffect(() => {
        if (selectedCategoryId && subcategories.length > 0) {
            // UPDATED: subcategories are already sorted by rank from useSortingData
            // Just map to IDs - no need to read metadata anymore
            const orderedIds = subcategories.map(s => s.id)

            console.log("[Sorting Debug] Subcategories from API (sorted by rank):", subcategories.map(s => `${s.name} (rank=${s.rank})`))
            console.log("[Sorting Debug] Using rank-based order:", orderedIds)

            setSubcategoryOrder(orderedIds)
        }
    }, [selectedCategoryId, subcategories, setSubcategoryOrder])

    useEffect(() => {
        if (selectedCategoryId && products.length > 0) {
            const configOrder = currentConfig?.product_order || []
            const existingIds = products.map((p) => p.id)

            // console.log("[Sorting Debug] Products from API:", products.map(p => p.title))
            // console.log("[Sorting Debug] Config Product Order:", configOrder)

            // CRITICAL FIX: Convert handles to IDs if config contains handles
            const normalizedConfigOrder = configOrder.map(item => {
                if (typeof item === 'string' && item.includes('-') && !item.match(/^prod_[0-9A-Z]{26}$/i)) {
                    const match = products.find(p => p.handle === item)
                    if (match) {
                        // console.log(`[Sorting Debug] Converted product handle "${item}" to ID "${match.id}"`)
                        return match.id
                    }
                }
                return item
            })

            const preservedOrder = normalizedConfigOrder.filter((id) => existingIds.includes(id))
            const newItems = existingIds.filter((id) => !normalizedConfigOrder.includes(id))

            // If no config exists, sort new items alphabetically as fallback
            const sortedNewItems = normalizedConfigOrder.length === 0
                ? newItems.sort((a, b) => {
                    const titleA = products.find(p => p.id === a)?.title || ""
                    const titleB = products.find(p => p.id === b)?.title || ""
                    return titleA.localeCompare(titleB)
                })
                : newItems

            const fullOrder = [...preservedOrder, ...sortedNewItems]

            // console.log("[Sorting Debug] Products Preserved:", preservedOrder.map(id => products.find(p => p.id === id)?.title))
            // console.log("[Sorting Debug] Products New:", sortedNewItems.map(id => products.find(p => p.id === id)?.title))
            // console.log("[Sorting Debug] Products Final Order:", fullOrder.map(id => products.find(p => p.id === id)?.title))

            setProductOrder(fullOrder)
        }
    }, [selectedCategoryId, products, currentConfig, setProductOrder])

    const handleSave = async () => {
        await saveSorting()
    }

    return (
        <Container className="p-6">
            {/* Header with unified Save button */}
            <div className="mb-6 flex items-start justify-between">
                <div>
                    <Heading level="h1">Category Sorting</Heading>
                    <p className="text-ui-fg-muted text-sm mt-2">
                        Manage the display order of subcategories and products within each category.
                        Drag items to reorder them.
                    </p>
                </div>
                {selectedCategoryId && (
                    <Button
                        onClick={handleSave}
                        disabled={isSaving || !hasChanges}
                        isLoading={isSaving}
                    >
                        {isSaving ? "Saving..." : "Save Orders"}
                    </Button>
                )}
            </div>

            {isLoading ? (
                <div className="text-ui-fg-muted">Loading...</div>
            ) : (
                <div className="grid grid-cols-3 gap-4 h-[calc(100vh-200px)]">
                    {/* Left Panel: Category Selector */}
                    <div className="col-span-1">
                        <CategorySelector
                            categories={categories}
                            selectedCategoryId={selectedCategoryId}
                            onSelectCategory={setSelectedCategoryId}
                        />
                    </div>

                    {/* Middle Panel: Subcategories */}
                    <div className="col-span-1">
                        {selectedCategoryId ? (
                            <SubcategoriesList
                                subcategories={subcategories}
                                order={subcategoryOrder}
                                onOrderChange={setSubcategoryOrder}
                            />
                        ) : (
                            <Container className="h-full flex items-center justify-center">
                                <p className="text-ui-fg-muted text-sm">
                                    Select a category to manage subcategories
                                </p>
                            </Container>
                        )}
                    </div>

                    {/* Right Panel: Products */}
                    <div className="col-span-1">
                        {selectedCategoryId ? (
                            <ProductsList
                                products={products}
                                order={productOrder}
                                onOrderChange={setProductOrder}
                            />
                        ) : (
                            <Container className="h-full flex items-center justify-center">
                                <p className="text-ui-fg-muted text-sm">
                                    Select a category to manage products
                                </p>
                            </Container>
                        )}
                    </div>
                </div>
            )}
        </Container>
    )
}

export const config = defineRouteConfig({
    label: "Sorting",
    icon: ListTree,
    nested: "/products",
})

export default SortingPage

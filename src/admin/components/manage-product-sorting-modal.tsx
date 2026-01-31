import { useEffect } from "react"
import { Button, Heading, Text } from "@medusajs/ui"
import { XMark } from "@medusajs/icons"
import { useSortingData } from "../hooks/useSortingData"
import { useCategorySorting } from "../hooks/useCategorySorting"
import { ProductsList } from "./sorting/ProductsList"

interface ManageProductSortingModalProps {
    open: boolean
    onOpenChange: (open: boolean) => void
    categoryId: string
    categoryName: string
}

export const ManageProductSortingModal = ({
    open,
    onOpenChange,
    categoryId,
    categoryName,
}: ManageProductSortingModalProps) => {
    // Use existing hooks - SAME logic as /app/sorting page
    const {
        products,
        isLoading,
    } = useSortingData(categoryId)

    // Get current sorting config from first category
    const currentConfig = products.length > 0 ? {
        subcategory_order: [],
        product_order: [],
    } : undefined

    const {
        productOrder,
        setProductOrder,
        saveSorting,
        isSaving,
        hasChanges,
    } = useCategorySorting(categoryId, currentConfig)

    // Initialize product order when modal opens
    useEffect(() => {
        if (open && products.length > 0) {
            // For now, just use product IDs in current order
            const allProductIds = products.map((p) => p.id)
            setProductOrder(allProductIds)
        }
    }, [open, products])

    const handleSave = async () => {
        const success = await saveSorting()
        if (success) {
            // Hard refresh to update UI (custom metadata)
            window.location.reload()
        }
    }

    if (!open) return null

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
            <div className="bg-ui-bg-base rounded-lg shadow-xl w-full max-w-2xl max-h-[80vh] flex flex-col">
                {/* Header */}
                <div className="flex items-center justify-between p-6 border-b border-ui-border-base">
                    <div>
                        <Heading level="h2" className="text-ui-fg-base">
                            Manage Product Sorting
                        </Heading>
                        <Text className="text-ui-fg-subtle text-sm mt-1">
                            {categoryName}
                        </Text>
                    </div>
                    <Button
                        variant="transparent"
                        onClick={() => onOpenChange(false)}
                        className="text-ui-fg-subtle hover:text-ui-fg-base"
                    >
                        <XMark />
                    </Button>
                </div>

                {/* Content - Reuse ProductsList component */}
                <div className="flex-1 overflow-y-auto p-6">
                    {isLoading ? (
                        <div className="flex items-center justify-center py-12">
                            <Text className="text-ui-fg-subtle">
                                Loading products...
                            </Text>
                        </div>
                    ) : products.length === 0 ? (
                        <div className="flex items-center justify-center py-12">
                            <Text className="text-ui-fg-subtle">
                                No products in this category
                            </Text>
                        </div>
                    ) : (
                        <div className="space-y-2">
                            <Text className="text-ui-fg-subtle text-sm mb-4">
                                Drag and drop to reorder products (
                                {products.length} total)
                            </Text>
                            <ProductsList
                                products={products}
                                order={productOrder}
                                onOrderChange={setProductOrder}
                            />
                        </div>
                    )}
                </div>

                {/* Footer */}
                <div className="flex items-center justify-end gap-2 p-6 border-t border-ui-border-base">
                    <Button
                        variant="secondary"
                        onClick={() => onOpenChange(false)}
                        disabled={isSaving}
                    >
                        Cancel
                    </Button>
                    <Button
                        variant="primary"
                        onClick={handleSave}
                        disabled={
                            isSaving ||
                            isLoading ||
                            products.length === 0 ||
                            !hasChanges
                        }
                    >
                        {isSaving ? "Saving..." : "Save Order"}
                    </Button>
                </div>
            </div>
        </div>
    )
}

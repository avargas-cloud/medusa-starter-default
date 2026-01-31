import { useState, useEffect } from "react"
import { Button, Heading, Text } from "@medusajs/ui"
import { XMark } from "@medusajs/icons"
import {
    DndContext,
    closestCenter,
    KeyboardSensor,
    PointerSensor,
    useSensor,
    useSensors,
    DragEndEvent,
} from "@dnd-kit/core"
import {
    arrayMove,
    SortableContext,
    sortableKeyboardCoordinates,
    verticalListSortingStrategy,
} from "@dnd-kit/sortable"
import { SortableItem } from "./sorting/SortableItem"

interface Product {
    id: string
    title: string
    handle: string
    thumbnail?: string
}

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
    const [products, setProducts] = useState<Product[]>([])
    const [productOrder, setProductOrder] = useState<string[]>([])
    const [loading, setLoading] = useState(false)
    const [saving, setSaving] = useState(false)

    const sensors = useSensors(
        useSensor(PointerSensor),
        useSensor(KeyboardSensor, {
            coordinateGetter: sortableKeyboardCoordinates,
        })
    )

    // Fetch products when modal opens
    useEffect(() => {
        if (open && categoryId) {
            fetchProducts()
        }
    }, [open, categoryId])

    const fetchProducts = async () => {
        setLoading(true)
        try {
            // Fetch category metadata to get current order
            const categoryRes = await fetch(`/admin/product-categories/${categoryId}?fields=+metadata`, {
                credentials: "include",
            })
            const categoryData = await categoryRes.json()
            const currentOrder = categoryData.product_category?.metadata?.sorting_config?.product_order || []

            // Fetch all products in category
            const productsRes = await fetch(
                `/admin/products?category_id[]=${categoryId}&fields=id,title,handle,thumbnail&limit=1000`,
                { credentials: "include" }
            )
            const productsData = await productsRes.json()
            const allProducts = productsData.products || []

            setProducts(allProducts)

            // Initialize order (preserve existing order, append new products)
            const existingIds = allProducts.map((p: Product) => p.id)
            const preservedOrder = currentOrder.filter((id: string) => existingIds.includes(id))
            const newProducts = existingIds.filter((id: string) => !currentOrder.includes(id))
            setProductOrder([...preservedOrder, ...newProducts])
        } catch (error) {
            console.error("Failed to fetch products:", error)
        } finally {
            setLoading(false)
        }
    }

    const handleDragEnd = (event: DragEndEvent) => {
        const { active, over } = event

        if (over && active.id !== over.id) {
            setProductOrder((items) => {
                const oldIndex = items.findIndex((id) => id === active.id)
                const newIndex = items.findIndex((id) => id === over.id)
                return arrayMove(items, oldIndex, newIndex)
            })
        }
    }

    const handleSave = async () => {
        setSaving(true)
        try {
            // Fetch existing metadata
            const fetchRes = await fetch(`/admin/product-categories/${categoryId}?fields=+metadata`, {
                credentials: "include",
            })
            const fetchData = await fetchRes.json()
            const existingMetadata = fetchData.product_category?.metadata || {}

            // Update metadata with new product order
            const response = await fetch(`/admin/product-categories/${categoryId}`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                credentials: "include",
                body: JSON.stringify({
                    metadata: {
                        ...existingMetadata,
                        sorting_config: {
                            ...existingMetadata.sorting_config,
                            product_order: productOrder,
                        },
                    },
                }),
            })

            if (!response.ok) {
                throw new Error("Failed to save product order")
            }

            // Hard refresh to update UI (since it's custom metadata)
            window.location.reload()
        } catch (error) {
            console.error("Failed to save product order:", error)
            alert("Failed to save product order. Please try again.")
        } finally {
            setSaving(false)
        }
    }

    if (!open) return null

    // Sort products by current order
    const orderedProducts = productOrder
        .map((id) => products.find((p) => p.id === id))
        .filter(Boolean) as Product[]

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

                {/* Content */}
                <div className="flex-1 overflow-y-auto p-6">
                    {loading ? (
                        <div className="flex items-center justify-center py-12">
                            <Text className="text-ui-fg-subtle">Loading products...</Text>
                        </div>
                    ) : orderedProducts.length === 0 ? (
                        <div className="flex items-center justify-center py-12">
                            <Text className="text-ui-fg-subtle">No products in this category</Text>
                        </div>
                    ) : (
                        <div className="space-y-2">
                            <Text className="text-ui-fg-subtle text-sm mb-4">
                                Drag and drop to reorder products ({orderedProducts.length} total)
                            </Text>
                            <DndContext
                                sensors={sensors}
                                collisionDetection={closestCenter}
                                onDragEnd={handleDragEnd}
                            >
                                <SortableContext
                                    items={productOrder}
                                    strategy={verticalListSortingStrategy}
                                >
                                    {orderedProducts.map((product) => (
                                        <SortableItem
                                            key={product.id}
                                            id={product.id}
                                            label={product.title}
                                        />
                                    ))}
                                </SortableContext>
                            </DndContext>
                        </div>
                    )}
                </div>

                {/* Footer */}
                <div className="flex items-center justify-end gap-2 p-6 border-t border-ui-border-base">
                    <Button
                        variant="secondary"
                        onClick={() => onOpenChange(false)}
                        disabled={saving}
                    >
                        Cancel
                    </Button>
                    <Button
                        variant="primary"
                        onClick={handleSave}
                        disabled={saving || loading || orderedProducts.length === 0}
                    >
                        {saving ? "Saving..." : "Save Order"}
                    </Button>
                </div>
            </div>
        </div>
    )
}

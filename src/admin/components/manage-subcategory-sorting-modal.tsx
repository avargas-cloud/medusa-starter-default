import { useEffect, useState } from "react"
import { Button, Heading, Text } from "@medusajs/ui"
import { XMark } from "@medusajs/icons"
import {
    DndContext,
    closestCenter,
    KeyboardSensor,
    PointerSensor,
    useSensor,
    useSensors,
} from "@dnd-kit/core"
import {
    arrayMove,
    SortableContext,
    sortableKeyboardCoordinates,
    rectSortingStrategy,
} from "@dnd-kit/sortable"
import { useSortingData } from "../hooks/useSortingData"
import { useCategorySorting } from "../hooks/useCategorySorting"
import { CategoryGridItem } from "./sorting/CategoryGridItem"

interface Subcategory {
    id: string
    name: string
    handle: string
    rank?: number
    metadata?: {
        image?: { url: string }
    }
}

interface ManageSubcategorySortingModalProps {
    open: boolean
    onOpenChange: (open: boolean) => void
    categoryId: string
    categoryName: string
}

export const ManageSubcategorySortingModal = ({
    open,
    onOpenChange,
    categoryId,
    categoryName,
}: ManageSubcategorySortingModalProps) => {
    const [currentConfig, setCurrentConfig] = useState<{
        subcategory_order: string[]
        product_order: string[]
    } | undefined>(undefined)

    // Use existing hooks - SAME logic as /app/sorting page
    const {
        subcategories,
        isLoading,
    } = useSortingData(categoryId)

    const {
        subcategoryOrder,
        setSubcategoryOrder,
        saveSorting,
        isSaving,
        hasChanges,
    } = useCategorySorting(categoryId, currentConfig)

    // DnD sensors
    const sensors = useSensors(
        useSensor(PointerSensor),
        useSensor(KeyboardSensor, {
            coordinateGetter: sortableKeyboardCoordinates,
        })
    )

    // Load existing sorting config when modal opens
    useEffect(() => {
        if (open && categoryId) {
            const loadConfig = async () => {
                try {
                    const res = await fetch(
                        `/admin/product-categories/${categoryId}?fields=+metadata`,
                        { credentials: "include" }
                    )
                    const data = await res.json()
                    const config = data.product_category?.metadata?.sorting_config || {
                        subcategory_order: [],
                        product_order: [],
                    }
                    setCurrentConfig(config)
                } catch (error) {
                    console.error("Failed to load sorting config:", error)
                    setCurrentConfig({
                        subcategory_order: [],
                        product_order: [],
                    })
                }
            }
            loadConfig()
        }
    }, [open, categoryId])

    // Initialize subcategory order when modal opens AND we have both subcategories and config
    useEffect(() => {
        if (open && subcategories.length > 0 && currentConfig) {
            const existingOrder = currentConfig.subcategory_order || []
            const allSubcategoryIds = subcategories.map((c) => c.id)

            // PRESERVE existing order, append new subcategories at end
            const preservedOrder = existingOrder.filter((id: string) =>
                allSubcategoryIds.includes(id)
            )
            const newSubcategories = allSubcategoryIds.filter(
                (id) => !existingOrder.includes(id)
            )

            setSubcategoryOrder([...preservedOrder, ...newSubcategories])
        }
    }, [open, subcategories, currentConfig])

    const handleDragEnd = (event: any) => {
        const { active, over } = event

        if (over && active.id !== over.id) {
            setSubcategoryOrder((items) => {
                const oldIndex = items.indexOf(active.id)
                const newIndex = items.indexOf(over.id)
                return arrayMove(items, oldIndex, newIndex)
            })
        }
    }

    const handleSave = async () => {
        const success = await saveSorting()
        if (success) {
            // Hard refresh to update UI (custom metadata)
            window.location.reload()
        }
    }

    // Order subcategories based on subcategoryOrder array
    const orderedSubcategories = subcategoryOrder
        .map((id) => subcategories.find((c) => c.id === id))
        .filter(Boolean) as Subcategory[]

    if (!open) return null

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
            <div className="bg-ui-bg-base rounded-lg shadow-xl w-full h-full max-w-7xl max-h-[90vh] flex flex-col">
                {/* Header */}
                <div className="flex items-center justify-between p-6 border-b border-ui-border-base shrink-0">
                    <div>
                        <Heading level="h2" className="text-ui-fg-base">
                            Manage Subcategory Sorting
                        </Heading>
                        <Text className="text-ui-fg-subtle text-sm mt-1">
                            {categoryName} • {subcategories.length} subcategories
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

                {/* Content - Grid Layout */}
                <div className="flex-1 overflow-y-auto p-6">
                    {isLoading ? (
                        <div className="flex items-center justify-center py-12">
                            <Text className="text-ui-fg-subtle">
                                Loading subcategories...
                            </Text>
                        </div>
                    ) : subcategories.length === 0 ? (
                        <div className="flex items-center justify-center py-12">
                            <Text className="text-ui-fg-subtle">
                                No subcategories in this category
                            </Text>
                        </div>
                    ) : (
                        <div className="space-y-4">
                            <Text className="text-ui-fg-subtle text-sm">
                                Drag and drop to reorder • {subcategories.length} total
                            </Text>
                            <DndContext
                                sensors={sensors}
                                collisionDetection={closestCenter}
                                onDragEnd={handleDragEnd}
                            >
                                <SortableContext
                                    items={subcategoryOrder}
                                    strategy={rectSortingStrategy}
                                >
                                    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
                                        {orderedSubcategories.map((subcategory) => (
                                            <CategoryGridItem
                                                key={subcategory.id}
                                                id={subcategory.id}
                                                name={subcategory.name}
                                                imageUrl={subcategory.metadata?.image?.url}
                                            />
                                        ))}
                                    </div>
                                </SortableContext>
                            </DndContext>
                        </div>
                    )}
                </div>

                {/* Footer */}
                <div className="flex items-center justify-end gap-2 p-6 border-t border-ui-border-base shrink-0">
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
                            subcategories.length === 0 ||
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

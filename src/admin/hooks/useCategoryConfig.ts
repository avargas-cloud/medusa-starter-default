import { useState, useEffect } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "@medusajs/ui"
import { arrayMove } from '@dnd-kit/sortable'
import { DragEndEvent } from '@dnd-kit/core'

interface Category {
    id: string
    name: string
    handle: string
    parent_category_id: string | null
    metadata?: {
        available_attributes?: string[]
        filter_config?: {
            override_inheritance: boolean
            active_filters: string[]
        }
    }
}

export function useCategoryConfig(selectedCategoryId: string | null, categories: Category[]) {
    const queryClient = useQueryClient()
    const [overrideInheritance, setOverrideInheritance] = useState(false)
    const [activeFilters, setActiveFilters] = useState<Set<string>>(new Set())

    // Load configuration when category is selected
    useEffect(() => {
        if (!selectedCategoryId) {
            setOverrideInheritance(false)
            setActiveFilters(new Set())
            return
        }

        const category = categories.find((c) => c.id === selectedCategoryId)
        if (!category) return

        const config = category.metadata?.filter_config

        if (config) {
            setOverrideInheritance(config.override_inheritance)
            setActiveFilters(new Set(config.active_filters || []))
        } else {
            setOverrideInheritance(false)
            setActiveFilters(new Set())
        }
    }, [selectedCategoryId])  // ⭐ Only re-run when category selection changes, not when categories array changes

    // Save mutation
    const saveMutation = useMutation({
        mutationFn: async () => {
            if (!selectedCategoryId) throw new Error("No category selected")

            const category = categories.find((c) => c.id === selectedCategoryId)
            if (!category) throw new Error("Category not found")

            const res = await fetch(`/admin/product-categories/${selectedCategoryId}`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                credentials: "include",
                body: JSON.stringify({
                    metadata: {
                        ...category.metadata,
                        filter_config: {
                            override_inheritance: overrideInheritance,
                            active_filters: Array.from(activeFilters).map((attribute_id, index) => ({
                                attribute_id,
                                order: index,
                                type: 'checkbox'
                            })),
                        },
                    },
                }),
            })

            if (!res.ok) throw new Error("Failed to save configuration")
            return res.json()
        },
        onSuccess: () => {
            toast.success("Filter configuration saved")
            queryClient.invalidateQueries({ queryKey: ["product_categories"] })
        },
        onError: (err) => {
            toast.error("Failed to save", { description: (err as Error).message })
        },
    })

    const handleToggleFilter = (attributeId: string) => {
        const newSet = new Set(activeFilters)
        if (newSet.has(attributeId)) {
            newSet.delete(attributeId)
        } else {
            newSet.add(attributeId)
        }
        setActiveFilters(newSet)
    }

    const handleDragEnd = (event: DragEndEvent) => {
        const { active, over } = event

        if (over && active.id !== over.id) {
            setActiveFilters((filters) => {
                const oldIndex = Array.from(filters).indexOf(active.id as string)
                const newIndex = Array.from(filters).indexOf(over.id as string)
                const filtersArray = arrayMove(Array.from(filters), oldIndex, newIndex)
                return new Set(filtersArray)
            })
        }
    }

    const handleSave = () => {
        saveMutation.mutate()
    }

    return {
        overrideInheritance,
        setOverrideInheritance,
        activeFilters,
        handleToggleFilter,
        handleDragEnd,
        handleSave,
        isSaving: saveMutation.isPending,
    }
}

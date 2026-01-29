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
    // ⭐ Save mutation - Generates filters JSON and saves to metadata
    const saveMutation = useMutation({
        mutationFn: async () => {
            if (!selectedCategoryId) throw new Error("No category selected")

            // Call generate-filters endpoint
            const res = await fetch(`/admin/product-categories/${selectedCategoryId}/generate-filters`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                credentials: "include",
                body: JSON.stringify({
                    active_filters: Array.from(activeFilters),
                    override_inheritance: overrideInheritance,
                }),
            })

            if (!res.ok) {
                const error = await res.json()
                throw new Error(error.message || "Failed to generate filters")
            }

            return res.json()
        },
        onSuccess: (data) => {
            toast.success(`Filters generated: ${data.filters_generated} filters for ${data.total_products} products`)
            queryClient.invalidateQueries({ queryKey: ["product_categories"] })
        },
        onError: (err) => {
            toast.error("Failed to generate filters", { description: (err as Error).message })
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
        setActiveFilters, // ⭐ Export for bulk operations like Select All
        handleToggleFilter,
        handleDragEnd,
        handleSave,
        isSaving: saveMutation.isPending,
    }
}

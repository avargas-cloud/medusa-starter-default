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
            available_filters?: string[] | Array<{ attribute_id: string; order: number; type: string }>
            active_filters: string[] | Array<{ attribute_id: string; order: number; type: string }>
        }
    }
}

export function useCategoryConfig(selectedCategoryId: string | null, categories: Category[]) {
    const queryClient = useQueryClient()
    const [overrideInheritance, setOverrideInheritance] = useState(false)
    const [activeFilters, setActiveFilters] = useState<Set<string>>(new Set())
    const [inheritedFilters, setInheritedFilters] = useState<Set<string>>(new Set())
    const [inheritedFromParentName, setInheritedFromParentName] = useState<string | null>(null)
    const [newlyAddedIds, setNewlyAddedIds] = useState<Set<string>>(new Set())

    // Load configuration when category is selected
    useEffect(() => {
        if (!selectedCategoryId) {
            setOverrideInheritance(false)
            setActiveFilters(new Set())
            setInheritedFilters(new Set())
            setInheritedFromParentName(null)
            setNewlyAddedIds(new Set())
            return
        }

        const category = categories.find((c) => c.id === selectedCategoryId)
        if (!category) return

        const config = category.metadata?.filter_config

        if (config) {
            setOverrideInheritance(config.override_inheritance ?? false)

            // ⭐ Parse active_filters (can be string[] or object[])
            let activeIds: string[] = []
            if (config.active_filters && config.active_filters.length > 0) {
                const first = config.active_filters[0]
                if (typeof first === "string") {
                    activeIds = config.active_filters as string[]
                } else if (typeof first === "object" && first && 'attribute_id' in first) {
                    activeIds = config.active_filters.map(f =>
                        typeof f === 'string' ? f : (f as { attribute_id: string }).attribute_id
                    )
                }
            }
            setActiveFilters(new Set(activeIds))

            // ⭐ NEW: Fetch inherited filters from parent if not overriding
            if (!config.override_inheritance && category.parent_category_id) {
                const parent = categories.find(c => c.id === category.parent_category_id)
                if (parent) {
                    const parentConfig = parent.metadata?.filter_config
                    let parentActiveIds: string[] = []

                    if (parentConfig?.active_filters && parentConfig.active_filters.length > 0) {
                        const first = parentConfig.active_filters[0]
                        if (typeof first === "string") {
                            parentActiveIds = parentConfig.active_filters as string[]
                        } else if (typeof first === "object" && (first as any).attribute_id) {
                            parentActiveIds = (parentConfig.active_filters as Array<{ attribute_id: string }>).map(f => f.attribute_id)
                        }
                    }

                    setInheritedFilters(new Set(parentActiveIds))
                    setInheritedFromParentName(parent.name)
                } else {
                    setInheritedFilters(new Set())
                    setInheritedFromParentName(null)
                }
            } else {
                setInheritedFilters(new Set())
                setInheritedFromParentName(null)
            }
        } else {
            setOverrideInheritance(false)
            setActiveFilters(new Set())
            setInheritedFilters(new Set())
            setInheritedFromParentName(null)
        }
    }, [selectedCategoryId, categories])  // ⭐ Include categories to update when parent changes

    // ⭐ NEW: Bidirectional toggle behavior
    // When override is enabled: copy inherited → active
    // When override is disabled: clear active, restore inherited display
    useEffect(() => {
        if (!selectedCategoryId) return

        const category = categories.find((c) => c.id === selectedCategoryId)
        if (!category || !category.parent_category_id) return

        const parent = categories.find(c => c.id === category.parent_category_id)
        if (!parent) return

        const parentConfig = parent.metadata?.filter_config
        if (!parentConfig) return

        // Parse parent's active filters
        let parentActiveIds: string[] = []
        if (parentConfig.active_filters && parentConfig.active_filters.length > 0) {
            const first = parentConfig.active_filters[0]
            if (typeof first === "string") {
                parentActiveIds = parentConfig.active_filters as string[]
            } else if (typeof first === "object" && (first as any).attribute_id) {
                parentActiveIds = (parentConfig.active_filters as Array<{ attribute_id: string }>).map(f => f.attribute_id)
            }
        }

        if (overrideInheritance) {
            // Override ON: Copy inherited to active (if we have inherited and active is empty)
            if (inheritedFilters.size > 0 && activeFilters.size === 0) {
                console.log('🔄 Override enabled - copying inherited filters to active')
                setActiveFilters(new Set(inheritedFilters))
                setInheritedFilters(new Set())
                setInheritedFromParentName(null)
            }
        } else {
            // Override OFF: Clear active only if it has filters, restore inherited display
            const parentSet = new Set(parentActiveIds)
            const parentSetString = JSON.stringify([...parentSet].sort())
            const currentInheritedString = JSON.stringify([...inheritedFilters].sort())

            // Only update if something actually changed
            if (activeFilters.size > 0 || currentInheritedString !== parentSetString) {
                console.log('🔄 Override disabled - restoring inherited filters display')
                if (activeFilters.size > 0) {
                    setActiveFilters(new Set())
                }
                if (currentInheritedString !== parentSetString) {
                    setInheritedFilters(parentSet)
                    setInheritedFromParentName(parent.name)
                }
            }
        }
    }, [overrideInheritance, selectedCategoryId, categories]) // All dependencies included

    // Save mutation
    // ⭐ Save mutation - Generates filters JSON and saves to metadata
    const saveMutation = useMutation({
        mutationFn: async () => {
            if (!selectedCategoryId) throw new Error("No category selected")

            // Call generate-filters endpoint
            const activeFiltersArray = Array.from(activeFilters)
            const res = await fetch(`/admin/product-categories/${selectedCategoryId}/generate-filters`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                credentials: "include",
                body: JSON.stringify({
                    active_filters: activeFiltersArray.map((attrId, index) => ({
                        attribute_id: attrId,
                        order: index,
                        type: 'checkbox'
                    })),
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
            setNewlyAddedIds(new Set()) // Clear after save
        },
        onError: (err) => {
            toast.error("Failed to generate filters", { description: (err as Error).message })
        },
    })

    const handleToggleFilter = (attributeId: string) => {
        console.log('🔍 handleToggleFilter called with:', attributeId)
        console.log('   Current activeFilters:', Array.from(activeFilters))

        const newSet = new Set(activeFilters)
        if (newSet.has(attributeId)) {
            // Removing
            console.log('   ➖ Removing from active')
            newSet.delete(attributeId)
            setNewlyAddedIds(prev => {
                const updated = new Set(prev)
                updated.delete(attributeId)
                return updated
            })
        } else {
            // Adding - mark as new
            console.log('   ➕ Adding to active')
            newSet.add(attributeId)
            setNewlyAddedIds(prev => new Set(prev).add(attributeId))
        }
        setActiveFilters(newSet)
        console.log('   New activeFilters:', Array.from(newSet))
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
        inheritedFilters, // ⭐ NEW: Filters inherited from parent
        inheritedFromParentName, // ⭐ NEW: Parent category name
        newlyAddedIds, // ⭐ Export for "New" badges
        setNewlyAddedIds, // ⭐ Export so page can update when adding filters
        handleToggleFilter,
        handleDragEnd,
        handleSave,
        isSaving: saveMutation.isPending,
    }
}

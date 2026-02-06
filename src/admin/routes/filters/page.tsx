import { defineRouteConfig } from "@medusajs/admin-sdk"
import { Funnel } from "@medusajs/icons"
import {
    Container,
    Heading,
    Text,
    Button,
    Checkbox,
} from "@medusajs/ui"
import { useState, useEffect } from "react"
import { CategoryTreeNode } from "../../components/filters/CategoryTreeNode"
import { ActiveFiltersSection } from "../../components/filters/ActiveFiltersSection"
import { AvailableFiltersSection } from "../../components/filters/AvailableFiltersSection"
import { useFiltersData } from "../../hooks/useFiltersData"
import { useCategoryConfig } from "../../hooks/useCategoryConfig"

// ============================================================================
// CONFIG
// ============================================================================

export const config = defineRouteConfig({
    label: "Filters",
    icon: Funnel,
    nested: "/products",
})

// ============================================================================
// MAIN PAGE COMPONENT
// ============================================================================

export default function FiltersPage() {
    const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(null)

    // ⭐ Custom hooks
    const { categories, attributes, isLoading } = useFiltersData()
    const {
        overrideInheritance,
        setOverrideInheritance,
        activeFilters,
        setActiveFilters,
        inheritedFilters, // ⭐ NEW: Inherited from parent
        inheritedFromParentName, // ⭐ NEW: Parent category name
        newlyAddedIds,
        setNewlyAddedIds,
        handleToggleFilter,
        handleDragEnd,
        handleSave,
        isSaving,
    } = useCategoryConfig(selectedCategoryId, categories)

    // Build category tree
    const buildTree = (parentId: string | null) => {
        return categories
            .filter((cat) => cat.parent_category_id === parentId)
            .sort((a, b) => a.name.localeCompare(b.name))
    }

    const rootCategories = buildTree(null)

    // ⭐ Auto-select first root category on load
    useEffect(() => {
        if (!selectedCategoryId && rootCategories.length > 0) {
            setSelectedCategoryId(rootCategories[0]!.id)
        }
    }, [rootCategories, selectedCategoryId])

    // Get children for a category
    const getChildren = (categoryId: string) => {
        return categories.filter((cat) => cat.parent_category_id === categoryId)
    }

    const selectedCategory = categories.find((c) => c.id === selectedCategoryId)

    const renderCategoryTree = (cats: any[], level = 0): JSX.Element[] => {
        return cats.map((cat) => {
            return (
                <CategoryTreeNode
                    key={cat.id}
                    category={cat}
                    getChildren={getChildren}
                    selectedId={selectedCategoryId}
                    onSelect={setSelectedCategoryId}
                    hasConfig={!!cat.metadata?.filter_config?.override_inheritance}
                    level={level}
                />
            )
        })
    }

    const [isNuclearSyncing, setIsNuclearSyncing] = useState(false)

    const handleNuclearSync = async () => {
        const userInput = prompt(
            '☢️ NUCLEAR SYNC\n\n' +
            'This will regenerate filters for ALL 75 configured categories.\n\n' +
            '⏱️ This process will take approximately 5-8 minutes.\n' +
            '⚠️ Do not close this page while syncing.\n\n' +
            'To confirm, please type: sync'
        )

        if (userInput !== 'sync') {
            if (userInput !== null) {
                alert('❌ Nuclear sync cancelled - confirmation text must match exactly')
            }
            return
        }

        setIsNuclearSyncing(true)

        try {
            const response = await fetch('/admin/product-categories/nuclear-sync', {
                method: 'POST',
                credentials: 'include'
            })

            if (response.ok) {
                const result = await response.json()
                alert(`✅ Nuclear Sync Complete!\n\nPhase 1: ${result.phase1.processed} categories synced\nPhase 2: ${result.phase2.generated} filters generated`)
                window.location.reload()
            } else {
                throw new Error(`Failed: ${response.status}`)
            }
        } catch (error: any) {
            alert(`❌ Nuclear sync failed: ${error.message}`)
        } finally {
            setIsNuclearSyncing(false)
        }
    }

    if (isLoading) {
        return (
            <Container className="h-screen flex items-center justify-center">
                <Text>Loading...</Text>
            </Container>
        )
    }

    return (
        <Container className="p-0">
            {/* HEADER */}
            <div className="px-8 py-6 border-b border-ui-border-base flex justify-between items-start">
                <div>
                    <Heading level="h1">Category Filters</Heading>
                    <Text className="text-ui-fg-subtle mt-1">
                        Configure which attributes appear as filters for each category
                    </Text>
                </div>

                {/* NUCLEAR SYNC BUTTON */}
                <Button
                    variant="danger"
                    size="small"
                    onClick={handleNuclearSync}
                    isLoading={isNuclearSyncing}
                    disabled={isNuclearSyncing}
                >
                    {isNuclearSyncing ? 'Syncing...' : '🔥 Nuclear Sync'}
                </Button>
            </div>

            {/* TWO COLUMN LAYOUT */}
            <div className="flex" style={{ height: "calc(100vh - 180px)" }}>
                {/* LEFT: Category Tree */}
                <div className="w-1/3 border-r border-ui-border-base overflow-y-auto p-4">
                    <div className="mb-3">
                        <Text size="small" weight="plus" className="text-ui-fg-subtle">
                            CATEGORIES
                        </Text>
                    </div>

                    {rootCategories.length === 0 ? (
                        <Text className="text-ui-fg-muted italic">No categories found</Text>
                    ) : (
                        <div className="flex flex-col gap-1">
                            {renderCategoryTree(rootCategories)}
                        </div>
                    )}
                </div>

                {/* RIGHT: Filter Configuration */}
                <div className="flex-1 flex flex-col">
                    {!selectedCategoryId ? (
                        <div className="flex flex-col items-center justify-center h-full text-ui-fg-subtle">
                            <Funnel className="w-12 h-12 mb-4 opacity-40" />
                            <Text weight="plus">Select a category</Text>
                            <Text size="small" className="mt-1">
                                Choose a category from the left to configure its filters
                            </Text>
                        </div>
                    ) : (
                        <>
                            {/* STICKY Header */}
                            <div className="sticky top-0 bg-ui-bg-base border-b border-ui-border-base px-5 py-3 z-10">
                                <div className="flex items-start justify-between">
                                    <div className="flex-1">
                                        <Heading level="h2" className="text-lg">{selectedCategory?.name}</Heading>
                                        <Text className="text-ui-fg-subtle text-xs mt-0.5">
                                            {selectedCategory?.handle}
                                        </Text>
                                    </div>

                                    {/* Save Button - Moved to header */}
                                    <Button
                                        variant="primary"
                                        onClick={handleSave}
                                        isLoading={isSaving}
                                        size="small"
                                    >
                                        Save Configuration
                                    </Button>
                                </div>

                                {/* ⭐ OVERRIDE TOGGLE - Moved here */}
                                <div className="border border-ui-border-base rounded-lg p-2.5 bg-ui-bg-subtle mt-3">
                                    <label className="flex items-start gap-2.5 cursor-pointer">
                                        <Checkbox
                                            checked={overrideInheritance}
                                            onCheckedChange={(checked) =>
                                                setOverrideInheritance(checked as boolean)
                                            }
                                        />
                                        <div>
                                            <Text weight="plus" size="small">Override parent category filters</Text>
                                            <Text size="xsmall" className="text-ui-fg-subtle mt-0.5">
                                                Uncheck to inherit filters from parent category
                                            </Text>
                                        </div>
                                    </label>
                                </div>
                            </div>

                            {/* Scrollable content */}
                            <div className="flex-1 overflow-y-auto px-5 py-3">

                                {/* ⭐ ACTIVE FILTERS - Drag & Drop */}
                                <ActiveFiltersSection
                                    activeFilters={activeFilters}
                                    inheritedFilters={inheritedFilters}
                                    inheritedFromParentName={inheritedFromParentName}
                                    newlyAddedIds={newlyAddedIds}
                                    attributes={attributes}
                                    onDragEnd={handleDragEnd}
                                    onRemoveFilter={handleToggleFilter}
                                />

                                {/* Available Filters Section */}
                                <AvailableFiltersSection
                                    selectedCategory={selectedCategory}
                                    attributes={attributes}
                                    activeFilters={activeFilters}
                                    inheritedFilters={inheritedFilters}
                                    onAddToActive={(selectedIds) => {
                                        const newFilters = new Set(activeFilters)
                                        selectedIds.forEach(id => newFilters.add(id))
                                        setActiveFilters(newFilters)
                                        // ⭐ Track newly added for "New" badges
                                        setNewlyAddedIds(prev => new Set([...prev, ...selectedIds]))
                                    }}
                                    overrideInheritance={overrideInheritance}
                                />
                            </div>
                        </>
                    )}
                </div>
            </div>
        </Container>
    )
}

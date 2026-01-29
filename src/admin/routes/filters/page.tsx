import { defineRouteConfig } from "@medusajs/admin-sdk"
import { Funnel } from "@medusajs/icons"
import {
    Container,
    Heading,
    Text,
    Button,
    Checkbox,
} from "@medusajs/ui"
import { useState } from "react"
import { CategoryTreeNode } from "../../components/filters/CategoryTreeNode"
import { ActiveFiltersSection } from "../../components/filters/ActiveFiltersSection"
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
            <div className="px-8 py-6 border-b border-ui-border-base">
                <Heading level="h1">Category Filters</Heading>
                <Text className="text-ui-fg-subtle mt-1">
                    Configure which attributes appear as filters for each category
                </Text>
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
                            <div className="sticky top-0 bg-ui-bg-base border-b border-ui-border-base p-6 pb-4 z-10">
                                <Heading level="h2">{selectedCategory?.name}</Heading>
                                <Text className="text-ui-fg-subtle text-sm mt-1">
                                    {selectedCategory?.handle}
                                </Text>
                            </div>

                            {/* Scrollable content */}
                            <div className="flex-1 overflow-y-auto p-6 pt-4">

                                {/* ⭐ ACTIVE FILTERS - Drag & Drop */}
                                <ActiveFiltersSection
                                    activeFilters={activeFilters}
                                    attributes={attributes}
                                    onDragEnd={handleDragEnd}
                                    onRemoveFilter={handleToggleFilter}
                                />

                                {/* Override Toggle */}
                                <div className="border border-ui-border-base rounded-lg p-4 bg-ui-bg-subtle">
                                    <label className="flex items-start gap-3 cursor-pointer">
                                        <Checkbox
                                            checked={overrideInheritance}
                                            onCheckedChange={(checked) =>
                                                setOverrideInheritance(checked as boolean)
                                            }
                                        />
                                        <div>
                                            <Text weight="plus">Override parent category filters</Text>
                                            <Text size="small" className="text-ui-fg-subtle mt-1">
                                                Uncheck to inherit filters from parent category
                                            </Text>
                                        </div>
                                    </label>
                                </div>

                                {/* Filter List */}
                                <div>
                                    <Text weight="plus" className="mb-3">
                                        Available Filters
                                    </Text>

                                    {(() => {
                                        // Filter attributes by available_attributes from category metadata
                                        const availableAttrIds = selectedCategory?.metadata?.available_attributes

                                        // ⭐ Distinguish between undefined (not synced yet) and [] (synced but empty)
                                        const filteredAttributes = availableAttrIds === undefined
                                            ? attributes  // Not synced yet: show all
                                            : attributes.filter(attr => availableAttrIds.includes(attr.id))  // Synced: filter

                                        if (attributes.length === 0) {
                                            return (
                                                <Text className="text-ui-fg-muted italic">
                                                    No attributes defined in system
                                                </Text>
                                            )
                                        }

                                        if (filteredAttributes.length === 0 && (availableAttrIds?.length === 0 || availableAttrIds === undefined)) {
                                            return (
                                                <div className="border border-ui-border-base rounded-lg p-4 bg-ui-bg-subtle">
                                                    <Text className="text-ui-fg-muted italic text-center">
                                                        No attributes configured on products yet
                                                    </Text>
                                                    <Text size="small" className="text-ui-fg-subtle text-center mt-2">
                                                        Products exist in this category, but they don't have <code>metadata.attributes</code> defined
                                                    </Text>
                                                </div>
                                            )
                                        }

                                        return (
                                            <div>
                                                {(availableAttrIds?.length ?? 0) > 0 && (
                                                    <Text size="small" className="text-ui-fg-subtle mb-2">
                                                        Showing {filteredAttributes.length} attribute{filteredAttributes.length !== 1 ? 's' : ''} used in this category
                                                    </Text>
                                                )}
                                                <div className="border border-ui-border-base rounded-lg divide-y divide-ui-border-base">
                                                    {filteredAttributes.map((attr) => (
                                                        <label
                                                            key={attr.id}
                                                            className="flex items-center gap-3 p-3 hover:bg-ui-bg-subtle cursor-pointer"
                                                        >
                                                            <Checkbox
                                                                checked={activeFilters.has(attr.id)}
                                                                onCheckedChange={() => handleToggleFilter(attr.id)}
                                                                disabled={!overrideInheritance}
                                                            />
                                                            <div className="flex-1">
                                                                <Text size="small">{attr.label}</Text>
                                                                <Text size="xsmall" className="text-ui-fg-subtle">
                                                                    {attr.handle}
                                                                </Text>
                                                            </div>
                                                        </label>
                                                    ))}
                                                </div>
                                            </div>
                                        )
                                    })()}
                                </div>

                                {/* Save Button */}
                                <div className="flex justify-end pt-4 border-t border-ui-border-base">
                                    <Button
                                        variant="primary"
                                        onClick={handleSave}
                                        isLoading={isSaving}
                                    >
                                        Save Configuration
                                    </Button>
                                </div>
                            </div>
                        </>
                    )}
                </div>
            </div>
        </Container>
    )
}

import { Text, Checkbox, Button } from "@medusajs/ui"
import { useState } from "react"

interface AttributeKey {
    id: string
    label: string
    handle: string
}

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

interface AvailableFiltersSectionProps {
    selectedCategory: Category | undefined
    attributes: AttributeKey[]
    activeFilters: Set<string>
    onAddToActive: (selectedIds: Set<string>) => void
    overrideInheritance: boolean
}

export function AvailableFiltersSection({
    selectedCategory,
    attributes,
    activeFilters,
    onAddToActive,
    overrideInheritance,
}: AvailableFiltersSectionProps) {
    const [selectedForActivation, setSelectedForActivation] = useState<Set<string>>(new Set())

    // Filter attributes by available_attributes from category metadata
    const availableAttrIds = selectedCategory?.metadata?.available_attributes

    // ⭐ Distinguish between undefined (not synced yet) and [] (synced but empty)
    const filteredAttributes = availableAttrIds === undefined
        ? attributes  // Not synced yet: show all
        : attributes.filter(attr => availableAttrIds.includes(attr.id))  // Synced: filter

    // ⭐ Exclude already active filters (they appear in Active Filters section above)
    const inactiveAttributes = filteredAttributes.filter(attr => !activeFilters.has(attr.id))

    // Check if all inactive are selected
    const allSelected = inactiveAttributes.length > 0 &&
        inactiveAttributes.every(attr => selectedForActivation.has(attr.id))

    const handleToggleSelection = (attrId: string) => {
        const newSet = new Set(selectedForActivation)
        if (newSet.has(attrId)) {
            newSet.delete(attrId)
        } else {
            newSet.add(attrId)
        }
        setSelectedForActivation(newSet)
    }

    const handleSelectAll = () => {
        if (allSelected) {
            setSelectedForActivation(new Set())
        } else {
            setSelectedForActivation(new Set(inactiveAttributes.map(a => a.id)))
        }
    }

    const handleAddToActive = () => {
        onAddToActive(selectedForActivation)
        setSelectedForActivation(new Set())
    }

    return (
        <div>
            <div className="flex items-center justify-between mb-2">
                <Text weight="plus" className="text-sm">
                    Available Filters
                </Text>
                <Button
                    variant="transparent"
                    size="small"
                    onClick={handleSelectAll}
                    disabled={!overrideInheritance}
                >
                    {allSelected ? "Deselect All" : "Select All"}
                </Button>
            </div>

            {/* ⭐ Add to Active button */}
            {selectedForActivation.size > 0 && (
                <Button
                    variant="primary"
                    size="small"
                    className="w-full mb-2"
                    onClick={handleAddToActive}
                    disabled={!overrideInheritance}
                >
                    Add {selectedForActivation.size} to Active Filters →
                </Button>
            )}

            {(() => {
                if (attributes.length === 0) {
                    return (
                        <Text className="text-ui-fg-muted italic text-sm">
                            No attributes defined in system
                        </Text>
                    )
                }

                if (inactiveAttributes.length === 0 && (availableAttrIds?.length === 0 || availableAttrIds === undefined)) {
                    return (
                        <div className="border border-ui-border-base rounded-lg p-3 bg-ui-bg-subtle">
                            <Text className="text-ui-fg-muted italic text-center text-sm">
                                No attributes configured on products yet
                            </Text>
                            <Text size="xsmall" className="text-ui-fg-subtle text-center mt-1.5">
                                Products exist in this category, but they don't have <code>metadata.attributes</code> defined
                            </Text>
                        </div>
                    )
                }

                if (inactiveAttributes.length === 0) {
                    return (
                        <Text className="text-ui-fg-muted italic text-sm">
                            All available filters are already active
                        </Text>
                    )
                }

                return (
                    <div>
                        {(availableAttrIds?.length ?? 0) > 0 && (
                            <Text size="xsmall" className="text-ui-fg-subtle mb-1.5">
                                Showing {inactiveAttributes.length} attribute{inactiveAttributes.length !== 1 ? 's' : ''} available
                            </Text>
                        )}
                        <div className="border border-ui-border-base rounded-lg divide-y divide-ui-border-base">
                            {inactiveAttributes.map((attr) => (
                                <label
                                    key={attr.id}
                                    className="flex items-center gap-2.5 p-2.5 hover:bg-ui-bg-subtle cursor-pointer"
                                >
                                    <Checkbox
                                        checked={selectedForActivation.has(attr.id)}
                                        onCheckedChange={() => handleToggleSelection(attr.id)}
                                        disabled={!overrideInheritance}
                                    />
                                    <div className="flex-1">
                                        <Text size="small">
                                            {attr.label}{" "}
                                            <span className="text-ui-fg-subtle">({attr.handle})</span>
                                        </Text>
                                    </div>
                                </label>
                            ))}
                        </div>
                    </div>
                )
            })()}
        </div>
    )
}

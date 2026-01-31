import { Text, Button } from "@medusajs/ui"

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
            available_filters?: string[] | Array<{ attribute_id: string; order: number; type: string }>
            active_filters: string[] | Array<{ attribute_id: string; order: number; type: string }>
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

    // ⭐ Read available attributes from filter_config (populated by nuclear sync)
    // This contains ALL attributes found in products within this category + children
    const filterConfig = selectedCategory?.metadata?.filter_config
    const availableAttrIds = filterConfig?.available_filters?.map((f: any) =>
        typeof f === 'string' ? f : f.attribute_id
    )

    // ⭐ ONLY show filters if they were explicitly set by nuclear sync
    // DO NOT fallback to all attributes - that confuses users
    const filteredAttributes = availableAttrIds
        ? attributes.filter(attr => availableAttrIds.includes(attr.id))
        : []  // Show empty if not synced

    // ⭐ Exclude already active filters (they appear in Active Filters section above)
    const inactiveAttributes = filteredAttributes.filter(attr => !activeFilters.has(attr.id))

    // ⭐ Direct activation - single click like widget
    const handleActivateFilter = (attrId: string) => {
        if (!overrideInheritance) return
        onAddToActive(new Set([attrId]))
    }

    return (
        <div>
            <div className="flex items-center justify-between mb-3">
                <Text weight="plus" className="text-sm">
                    Available Filters ({inactiveAttributes.length})
                </Text>
            </div>

            {(() => {
                if (attributes.length === 0) {
                    return (
                        <Text className="text-ui-fg-muted italic text-sm">
                            No attributes defined in system
                        </Text>
                    )
                }

                if (filteredAttributes.length === 0) {
                    return (
                        <Text className="text-ui-fg-muted italic text-sm">
                            No attributes found in this category's products
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
                        <Text size="xsmall" className="text-ui-fg-subtle mb-1.5">
                            Alphabetical order • Click + to activate
                        </Text>
                        <div className="border border-ui-border-base rounded-lg divide-y divide-ui-border-base overflow-hidden bg-ui-bg-subtle">
                            {inactiveAttributes.map((attr) => (
                                <div
                                    key={attr.id}
                                    className="flex items-center gap-3 p-3 hover:bg-ui-bg-base-hover transition-colors"
                                >
                                    <div className="flex-1">
                                        <Text size="small">
                                            {attr.label}{" "}
                                            <span className="text-ui-fg-subtle">({attr.handle})</span>
                                        </Text>
                                    </div>
                                    <Button
                                        size="small"
                                        variant="secondary"
                                        disabled={!overrideInheritance}
                                        onClick={() => handleActivateFilter(attr.id)}
                                    >
                                        <svg
                                            xmlns="http://www.w3.org/2000/svg"
                                            width="16"
                                            height="16"
                                            viewBox="0 0 24 24"
                                            fill="none"
                                            stroke="currentColor"
                                            strokeWidth="2"
                                            strokeLinecap="round"
                                            strokeLinejoin="round"
                                        >
                                            <line x1="12" y1="5" x2="12" y2="19"></line>
                                            <line x1="5" y1="12" x2="19" y2="12"></line>
                                        </svg>
                                    </Button>
                                </div>
                            ))}
                        </div>
                        {!overrideInheritance && (
                            <Text className="text-ui-fg-muted text-xs mt-2">
                                Enable "Override parent category filters" to activate filters
                            </Text>
                        )}
                    </div>
                )
            })()}
        </div>
    )
}

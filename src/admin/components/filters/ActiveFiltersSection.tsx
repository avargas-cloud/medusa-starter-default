import { Text, Badge } from "@medusajs/ui"
import {
    DndContext,
    closestCenter,
    KeyboardSensor,
    PointerSensor,
    useSensor,
    useSensors,
    DragEndEvent,
} from '@dnd-kit/core'
import {
    SortableContext,
    sortableKeyboardCoordinates,
    verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { SortableFilterItem } from './SortableFilterItem'

interface AttributeKey {
    id: string
    label: string
    handle: string
}

interface ActiveFiltersSectionProps {
    activeFilters: Set<string>
    inheritedFilters?: Set<string> // ⭐ NEW: Inherited from parent
    inheritedFromParentName?: string | null // ⭐ NEW: Parent category name
    newlyAddedIds: Set<string>
    attributes: AttributeKey[]
    onDragEnd: (event: DragEndEvent) => void
    onRemoveFilter: (id: string) => void
}

export function ActiveFiltersSection({
    activeFilters,
    inheritedFilters = new Set(),
    inheritedFromParentName = null,
    newlyAddedIds,
    attributes,
    onDragEnd,
    onRemoveFilter,
}: ActiveFiltersSectionProps) {
    const sensors = useSensors(
        useSensor(PointerSensor),
        useSensor(KeyboardSensor, {
            coordinateGetter: sortableKeyboardCoordinates,
        })
    )

    const hasUnsavedChanges = newlyAddedIds.size > 0
    const totalFiltersCount = activeFilters.size + inheritedFilters.size

    return (
        <div className="mb-6">
            <div className="flex items-center gap-2 mb-3">
                <Text weight="plus">
                    Active Filters ({totalFiltersCount})
                </Text>
                {hasUnsavedChanges && (
                    <Badge size="small" color="orange">
                        Unsaved changes
                    </Badge>
                )}
            </div>

            {totalFiltersCount === 0 ? (
                <Text className="text-ui-fg-muted text-sm italic">
                    Select filters from available list below →
                </Text>
            ) : (
                <>
                    {/* ⭐ Inherited Filters (Read-only) */}
                    {inheritedFilters.size > 0 && inheritedFromParentName && (
                        <div className="mb-4">
                            <div className="flex items-center gap-2 mb-2">
                                <Text size="small" className="text-ui-fg-subtle">
                                    Inherited from {inheritedFromParentName}
                                </Text>
                                <Badge size="small" color="blue">
                                    {inheritedFilters.size}
                                </Badge>
                            </div>
                            <div className="flex flex-col gap-2 opacity-75">
                                {Array.from(inheritedFilters).map(attrId => {
                                    const attr = attributes.find(a => a.id === attrId)
                                    if (!attr) return null

                                    return (
                                        <div
                                            key={attr.id}
                                            className="flex items-center gap-3 p-3 rounded border bg-ui-bg-subtle border-ui-border-base"
                                        >
                                            <div className="flex-1">
                                                <Text size="small" weight="plus">
                                                    {attr.label}{" "}
                                                    <span className="text-ui-fg-muted font-normal">({attr.handle})</span>
                                                </Text>
                                            </div>
                                            <Badge size="small" color="grey">
                                                Inherited
                                            </Badge>
                                        </div>
                                    )
                                })}
                            </div>
                        </div>
                    )}

                    {/* ⭐ Manually Activated Filters (Drag & Drop) */}
                    {activeFilters.size > 0 && (
                        <>
                            {inheritedFilters.size > 0 && (
                                <Text size="small" className="text-ui-fg-subtle mb-2">
                                    Custom Filters (Override)
                                </Text>
                            )}
                            <Text className="text-ui-fg-muted text-xs mb-3">
                                Drag to reorder • Order affects storefront display
                            </Text>
                            <DndContext
                                sensors={sensors}
                                collisionDetection={closestCenter}
                                onDragEnd={onDragEnd}
                            >
                                <SortableContext
                                    items={Array.from(activeFilters)}
                                    strategy={verticalListSortingStrategy}
                                >
                                    <div className="flex flex-col gap-2">
                                        {Array.from(activeFilters).map(attrId => {
                                            const attr = attributes.find(a => a.id === attrId)
                                            if (!attr) return null

                                            const isNew = newlyAddedIds.has(attrId)

                                            return (
                                                <SortableFilterItem
                                                    key={attr.id}
                                                    id={attr.id}
                                                    label={attr.label}
                                                    handle={attr.handle}
                                                    isNew={isNew}
                                                    onRemove={() => onRemoveFilter(attr.id)}
                                                />
                                            )
                                        })}
                                    </div>
                                </SortableContext>
                            </DndContext>
                        </>
                    )}
                </>
            )}
        </div>
    )
}

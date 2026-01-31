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
    newlyAddedIds: Set<string>
    attributes: AttributeKey[]
    onDragEnd: (event: DragEndEvent) => void
    onRemoveFilter: (id: string) => void
}

export function ActiveFiltersSection({
    activeFilters,
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

    return (
        <div className="mb-6">
            <div className="flex items-center gap-2 mb-3">
                <Text weight="plus">
                    Active Filters ({activeFilters.size})
                </Text>
                {hasUnsavedChanges && (
                    <Badge size="small" color="orange">
                        Unsaved changes
                    </Badge>
                )}
            </div>

            {activeFilters.size === 0 ? (
                <Text className="text-ui-fg-muted text-sm italic">
                    Select filters from available list below →
                </Text>
            ) : (
                <>
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
        </div>
    )
}

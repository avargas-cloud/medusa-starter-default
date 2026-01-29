import { Text } from "@medusajs/ui"
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
    attributes: AttributeKey[]
    onDragEnd: (event: DragEndEvent) => void
    onRemoveFilter: (id: string) => void
}

export function ActiveFiltersSection({
    activeFilters,
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

    if (activeFilters.size === 0) {
        return null
    }

    return (
        <div className="mb-6">
            <Text weight="plus" className="mb-3">
                Active Filters ({activeFilters.size})
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

                            return (
                                <SortableFilterItem
                                    key={attr.id}
                                    id={attr.id}
                                    label={attr.label}
                                    handle={attr.handle}
                                    onRemove={() => onRemoveFilter(attr.id)}
                                />
                            )
                        })}
                    </div>
                </SortableContext>
            </DndContext>
        </div>
    )
}

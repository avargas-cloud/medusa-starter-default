import { Container, Heading, Text } from "@medusajs/ui"
import {
    DndContext,
    closestCenter,
    KeyboardSensor,
    PointerSensor,
    useSensor,
    useSensors,
} from "@dnd-kit/core"
import {
    arrayMove,
    SortableContext,
    sortableKeyboardCoordinates,
    verticalListSortingStrategy,
} from "@dnd-kit/sortable"
import { SortableItem } from "./SortableItem"

type Subcategory = {
    id: string
    name: string
    handle: string
}

type SubcategoriesListProps = {
    subcategories: Subcategory[]
    order: string[]
    onOrderChange: (order: string[]) => void
}

export const SubcategoriesList = ({
    subcategories,
    order,
    onOrderChange,
}: SubcategoriesListProps) => {
    const sensors = useSensors(
        useSensor(PointerSensor),
        useSensor(KeyboardSensor, {
            coordinateGetter: sortableKeyboardCoordinates,
        })
    )

    const handleDragEnd = (event: any) => {
        const { active, over } = event

        if (over && active.id !== over.id) {
            const oldIndex = order.indexOf(active.id)
            const newIndex = order.indexOf(over.id)
            const newOrder = arrayMove(order, oldIndex, newIndex)
            onOrderChange(newOrder)
        }
    }

    // Order subcategories based on order array
    const orderedSubcategories = order
        .map((id) => subcategories.find((s) => s.id === id))
        .filter(Boolean) as Subcategory[]

    // Add unordered subcategories at the end
    const unorderedSubcategories = subcategories.filter(
        (s) => !order.includes(s.id)
    )
    const allSubcategories = [...orderedSubcategories, ...unorderedSubcategories]

    console.log("[SubcategoriesList] Order prop:", order)
    console.log("[SubcategoriesList] Ordered items:", orderedSubcategories.map(s => s.name))
    console.log("[SubcategoriesList] Unordered items:", unorderedSubcategories.map(s => s.name))
    console.log("[SubcategoriesList] Final render order:", allSubcategories.map(s => s.name))

    return (
        <Container className="h-full flex flex-col">
            <Heading level="h2" className="mb-4">Subcategories</Heading>

            {allSubcategories.length === 0 ? (
                <Text className="text-ui-fg-muted text-sm">
                    No subcategories in this category
                </Text>
            ) : (
                <DndContext
                    sensors={sensors}
                    collisionDetection={closestCenter}
                    onDragEnd={handleDragEnd}
                >
                    <SortableContext
                        items={allSubcategories.map((s) => s.id)}
                        strategy={verticalListSortingStrategy}
                    >
                        <div className="space-y-2 overflow-y-auto flex-1">
                            {allSubcategories.map((subcategory) => (
                                <SortableItem
                                    key={subcategory.id}
                                    id={subcategory.id}
                                    name={subcategory.name}
                                    subtitle={subcategory.handle}
                                />
                            ))}
                        </div>
                    </SortableContext>
                </DndContext>
            )}
        </Container>
    )
}

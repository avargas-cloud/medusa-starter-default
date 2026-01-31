import { XMark } from "@medusajs/icons"
import { Text, Button, Badge } from "@medusajs/ui"
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'

interface SortableFilterItemProps {
    id: string
    label: string
    handle: string
    isNew?: boolean
    onRemove: () => void
}

export function SortableFilterItem({ id, label, handle, isNew, onRemove }: SortableFilterItemProps) {
    const {
        attributes,
        listeners,
        setNodeRef,
        transform,
        transition,
        isDragging,
    } = useSortable({ id })

    const style = {
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.5 : 1,
    }

    return (
        <div
            ref={setNodeRef}
            style={style}
            className={`flex items-center gap-3 p-3 rounded border cursor-move hover:bg-ui-bg-base-hover ${isNew
                ? "bg-ui-bg-warning-subtle border-ui-border-warning"
                : "bg-ui-bg-base border-ui-border-base"
                }`}
            {...attributes}
            {...listeners}
        >
            <div className="flex-1">
                <Text size="small" weight="plus">
                    {label}{" "}
                    <span className="text-ui-fg-muted font-normal">({handle})</span>
                </Text>
            </div>
            {isNew && (
                <Badge size="small" color="orange">
                    New
                </Badge>
            )}
            <Button
                size="small"
                variant="transparent"
                onPointerDown={(e) => {
                    e.stopPropagation() // ⭐ Prevent drag handler
                    console.log('🗑️ Remove button clicked for:', id, label)
                    onRemove()
                }}
            >
                <XMark />
            </Button>
        </div>
    )
}

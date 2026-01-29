import { XMark, EllipsisVertical } from "@medusajs/icons"
import { Text } from "@medusajs/ui"
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'

interface SortableFilterItemProps {
    id: string
    label: string
    handle: string
    onRemove: () => void
}

export function SortableFilterItem({ id, label, handle, onRemove }: SortableFilterItemProps) {
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
            className="flex items-center gap-2 px-3 py-2 bg-ui-bg-subtle border border-ui-border-base rounded-lg hover:bg-ui-bg-subtle-hover"
        >
            <button
                {...attributes}
                {...listeners}
                className="cursor-grab active:cursor-grabbing p-1 hover:bg-ui-bg-base rounded"
            >
                <EllipsisVertical className="text-ui-fg-muted" />
            </button>
            <div className="flex-1">
                <Text weight="plus" size="small">{label}</Text>
                <Text size="xsmall" className="text-ui-fg-subtle">{handle}</Text>
            </div>
            <button
                onClick={onRemove}
                className="p-1 hover:bg-ui-bg-base rounded text-ui-fg-muted hover:text-ui-fg-base"
            >
                <XMark />
            </button>
        </div>
    )
}

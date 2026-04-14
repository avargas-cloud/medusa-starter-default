import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { EllipsisVertical } from "@medusajs/icons";

interface SortableItemProps {
  id: string;
  name: string;
  subtitle?: string;
}

/**
 * Generic draggable item component for use in sortable lists
 */
export function SortableItem({ id, name, subtitle }: SortableItemProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="flex items-center gap-2 bg-ui-bg-base border border-ui-border-base rounded-md p-2 hover:bg-ui-bg-base-hover cursor-move"
    >
      <div
        {...attributes}
        {...listeners}
        className="flex items-center justify-center w-6 h-6 text-ui-fg-muted hover:text-ui-fg-base cursor-grab active:cursor-grabbing"
      >
        <EllipsisVertical />
      </div>
      <div className="flex-1">
        <div className="text-sm font-medium text-ui-fg-base">{name}</div>
        {subtitle && <div className="text-xs text-ui-fg-muted">{subtitle}</div>}
      </div>
    </div>
  );
}

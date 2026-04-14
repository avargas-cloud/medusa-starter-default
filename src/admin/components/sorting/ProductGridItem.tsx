import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { EllipsisVertical } from "@medusajs/icons";

interface ProductGridItemProps {
  id: string;
  name: string;
  thumbnail?: string;
}

/**
 * Grid-style product item with thumbnail and title below (Windows folder style)
 */
export function ProductGridItem({ id, name, thumbnail }: ProductGridItemProps) {
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
      className="flex flex-col items-center gap-2 bg-ui-bg-base border border-ui-border-base rounded-lg p-3 hover:bg-ui-bg-base-hover cursor-move group"
      {...attributes}
      {...listeners}
    >
      {/* Drag Handle - Top Right */}
      <div className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity">
        <EllipsisVertical className="text-ui-fg-muted" />
      </div>

      {/* Product Image */}
      <div className="w-24 h-24 rounded-md overflow-hidden bg-ui-bg-subtle flex items-center justify-center">
        {thumbnail ? (
          <img
            src={thumbnail}
            alt={name}
            className="w-full h-full object-cover"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-ui-fg-muted text-xs">
            No Image
          </div>
        )}
      </div>

      {/* Product Title */}
      <div className="text-center w-full">
        <div className="text-sm font-medium text-ui-fg-base line-clamp-2 break-words">
          {name}
        </div>
      </div>
    </div>
  );
}

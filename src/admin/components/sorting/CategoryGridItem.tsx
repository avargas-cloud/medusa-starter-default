import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { EllipsisVertical } from "@medusajs/icons";

interface CategoryGridItemProps {
  id: string;
  name: string;
  imageUrl?: string;
}

/**
 * Grid-style category item with image and title below (Windows folder style)
 * Images come from category metadata.image.url
 */
export function CategoryGridItem({
  id,
  name,
  imageUrl,
}: CategoryGridItemProps) {
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
      className="relative flex flex-col items-center gap-2 bg-ui-bg-base border border-ui-border-base rounded-lg p-3 hover:bg-ui-bg-base-hover cursor-move group"
      {...attributes}
      {...listeners}
    >
      {/* Drag Handle - Top Right */}
      <div className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity">
        <EllipsisVertical className="text-ui-fg-muted" />
      </div>

      {/* Category Image */}
      <div className="w-24 h-24 rounded-md overflow-hidden bg-ui-bg-subtle flex items-center justify-center">
        {imageUrl ? (
          <img
            src={imageUrl}
            alt={name}
            className="w-full h-full object-cover"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-ui-fg-muted text-xs text-center px-2">
            No Image
          </div>
        )}
      </div>

      {/* Category Name */}
      <div className="text-center w-full">
        <div className="text-sm font-medium text-ui-fg-base line-clamp-2 break-words">
          {name}
        </div>
      </div>
    </div>
  );
}

import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ArrowDownMini, ArrowUpMini, XMark } from "@medusajs/icons";
import { Badge, Button, Text } from "@medusajs/ui";

export type RelatedItem = {
  id: string;
  title: string;
  handle: string;
  thumbnail: string | null;
  status: string;
  in_stock: boolean;
};

interface SortableRelatedItemProps {
  item: RelatedItem;
  position: number;
  isWebSlot: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onRemove: () => void;
}

export const SortableRelatedItem = ({
  item,
  position,
  isWebSlot,
  canMoveUp,
  canMoveDown,
  onMoveUp,
  onMoveDown,
  onRemove,
}: SortableRelatedItemProps) => {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: item.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="flex items-center gap-3 rounded border border-ui-border-base bg-ui-bg-base p-3"
    >
      <div
        className="flex w-6 shrink-0 cursor-move items-center justify-center text-ui-fg-muted"
        {...attributes}
        {...listeners}
      >
        <Text size="small" weight="plus">
          {position + 1}
        </Text>
      </div>

      {item.thumbnail ? (
        <img
          src={item.thumbnail}
          alt={item.title}
          className="h-10 w-10 shrink-0 rounded object-cover"
        />
      ) : (
        <div className="h-10 w-10 shrink-0 rounded bg-ui-bg-subtle" />
      )}

      <div className="min-w-0 flex-1">
        <Text size="small" weight="plus" className="truncate">
          {item.title}
        </Text>
        <Text size="xsmall" className="truncate text-ui-fg-subtle">
          {item.handle}
        </Text>
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        {item.status !== "published" && (
          <Badge size="2xsmall" color="orange">
            Draft
          </Badge>
        )}
        {!item.in_stock && (
          <Badge size="2xsmall" color="grey">
            Out of stock
          </Badge>
        )}
        <Badge size="2xsmall" color={isWebSlot ? "green" : "grey"}>
          {isWebSlot ? "Web" : "Backup"}
        </Badge>
      </div>

      <div className="flex shrink-0 items-center gap-0.5">
        <Button
          size="small"
          variant="transparent"
          disabled={!canMoveUp}
          onClick={onMoveUp}
        >
          <ArrowUpMini />
        </Button>
        <Button
          size="small"
          variant="transparent"
          disabled={!canMoveDown}
          onClick={onMoveDown}
        >
          <ArrowDownMini />
        </Button>
        <Button size="small" variant="transparent" onClick={onRemove}>
          <XMark />
        </Button>
      </div>
    </div>
  );
};

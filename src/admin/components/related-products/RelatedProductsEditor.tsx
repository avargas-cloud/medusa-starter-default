import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { Button, Text, toast } from "@medusajs/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import type { MeiliProduct } from "../../lib/meili-types";

import { RelatedProductSearch } from "./RelatedProductSearch";
import { SortableRelatedItem, type RelatedItem } from "./SortableRelatedItem";

const MAX_RELATED = 8;
const WEB_SLOTS = 4;

type RelatedProductsResponse = {
  product_id: string;
  ids: string[];
  items: RelatedItem[];
  max: number;
};

type SaveResponse = RelatedProductsResponse & {
  reciprocal: { added_to: string[]; skipped_full: string[] };
};

interface RelatedProductsEditorProps {
  productId: string;
}

export const RelatedProductsEditor = ({
  productId,
}: RelatedProductsEditorProps) => {
  const queryClient = useQueryClient();
  const [items, setItems] = useState<RelatedItem[]>([]);

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const { data, isLoading, isError } = useQuery({
    queryKey: ["related-products", productId],
    queryFn: async () => {
      const res = await fetch(
        `/admin/products/${productId}/related-products`,
        { credentials: "include" }
      );
      if (!res.ok) throw new Error("Failed to load related products");
      return (await res.json()) as RelatedProductsResponse;
    },
  });

  useEffect(() => {
    if (data) setItems(data.items);
  }, [data]);

  const serverIds = data?.ids ?? [];
  const currentIds = items.map((i) => i.id);
  const hasChanges =
    currentIds.length !== serverIds.length ||
    currentIds.some((id, idx) => id !== serverIds[idx]);

  const save = useMutation({
    mutationFn: async (ids: string[]) => {
      const res = await fetch(
        `/admin/products/${productId}/related-products`,
        {
          method: "PUT",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ids }),
        }
      );
      const body = await res.json();
      if (!res.ok) {
        throw new Error(body?.message ?? "Failed to save related products");
      }
      return body as SaveResponse;
    },
    onSuccess: (body) => {
      setItems(body.items);
      const description =
        body.reciprocal.added_to.length > 0
          ? `Also added this product to ${body.reciprocal.added_to.length} related list(s).`
          : undefined;
      toast.success("Related products saved", { description });
      if (body.reciprocal.skipped_full.length > 0) {
        const titles = body.items
          .filter((i) => body.reciprocal.skipped_full.includes(i.id))
          .map((i) => i.title);
        toast.warning("Some reciprocal links were skipped", {
          description: `Already had 8: ${
            titles.length > 0
              ? titles.join(", ")
              : body.reciprocal.skipped_full.join(", ")
          }`,
        });
      }
      queryClient.invalidateQueries({
        queryKey: ["related-products", productId],
      });
      queryClient.invalidateQueries({ queryKey: ["product", productId] });
    },
    onError: (err) => {
      toast.error("Failed to save related products", {
        description: (err as Error).message,
      });
    },
  });

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    setItems((current) => {
      const oldIndex = current.findIndex((i) => i.id === active.id);
      const newIndex = current.findIndex((i) => i.id === over.id);
      if (oldIndex === -1 || newIndex === -1) return current;
      return arrayMove(current, oldIndex, newIndex);
    });
  };

  const moveItem = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= items.length) return;
    setItems((current) => arrayMove(current, index, target));
  };

  const removeItem = (id: string) => {
    setItems((current) => current.filter((i) => i.id !== id));
  };

  const addItem = (hit: MeiliProduct) => {
    if (items.length >= MAX_RELATED) return;
    setItems((current) => [
      ...current,
      {
        id: hit.id,
        title: hit.title,
        handle: hit.handle,
        thumbnail: hit.thumbnail,
        status: hit.status,
        in_stock: true,
      },
    ]);
  };

  const handleDiscard = () => {
    if (data) setItems(data.items);
  };

  const handleSave = () => {
    save.mutate(items.map((i) => i.id));
  };

  if (isLoading) {
    return (
      <Text size="small" className="text-ui-fg-subtle">
        Loading…
      </Text>
    );
  }

  if (isError || !data) {
    return (
      <Text size="small" className="text-ui-fg-error">
        Failed to load related products.
      </Text>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <RelatedProductSearch
        excludeIds={[productId, ...currentIds]}
        disabled={items.length >= MAX_RELATED}
        onPick={addItem}
      />

      {items.length === 0 ? (
        <Text size="small" className="text-ui-fg-subtle">
          No related products yet. Search above to add some.
        </Text>
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={currentIds}
            strategy={verticalListSortingStrategy}
          >
            <div className="flex flex-col gap-2">
              {items.map((item, index) => (
                <SortableRelatedItem
                  key={item.id}
                  item={item}
                  position={index}
                  isWebSlot={index < WEB_SLOTS}
                  canMoveUp={index > 0}
                  canMoveDown={index < items.length - 1}
                  onMoveUp={() => moveItem(index, -1)}
                  onMoveDown={() => moveItem(index, 1)}
                  onRemove={() => removeItem(item.id)}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      )}

      <div className="flex items-center justify-between border-t border-ui-border-base pt-4">
        <Text size="small" className="text-ui-fg-subtle">
          {items.length}/{MAX_RELATED}
        </Text>
        <div className="flex items-center gap-2">
          <Button
            size="small"
            variant="secondary"
            disabled={!hasChanges || save.isPending}
            onClick={handleDiscard}
          >
            Discard
          </Button>
          <Button
            size="small"
            variant="primary"
            disabled={!hasChanges || save.isPending}
            isLoading={save.isPending}
            onClick={handleSave}
          >
            Save
          </Button>
        </div>
      </div>
    </div>
  );
};

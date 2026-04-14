import { useEffect, useState } from "react";
import { Button, Heading, Text } from "@medusajs/ui";
import { XMark } from "@medusajs/icons";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  rectSortingStrategy,
} from "@dnd-kit/sortable";
import { useSortingData } from "../hooks/useSortingData";
import { useCategorySorting } from "../hooks/useCategorySorting";
import { ProductGridItem } from "./sorting/ProductGridItem";

interface ManageProductSortingModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  categoryId: string;
  categoryName: string;
}

export const ManageProductSortingModal = ({
  open,
  onOpenChange,
  categoryId,
  categoryName,
}: ManageProductSortingModalProps) => {
  const [currentConfig, setCurrentConfig] = useState<
    | {
        subcategory_order: string[];
        product_order: string[];
      }
    | undefined
  >(undefined);

  // Use existing hooks - SAME logic as /app/sorting page
  const { products, isLoading } = useSortingData(categoryId);

  const { productOrder, setProductOrder, saveSorting, isSaving, hasChanges } =
    useCategorySorting(categoryId, currentConfig);

  // DnD sensors
  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  // Load existing sorting config when modal opens
  useEffect(() => {
    if (open && categoryId) {
      const loadConfig = async () => {
        try {
          const res = await fetch(
            `/admin/product-categories/${categoryId}?fields=+metadata`,
            { credentials: "include" }
          );
          const data = await res.json();
          const config = data.product_category?.metadata?.sorting_config || {
            subcategory_order: [],
            product_order: [],
          };
          setCurrentConfig(config);
        } catch (error) {
          console.error("Failed to load sorting config:", error);
          setCurrentConfig({
            subcategory_order: [],
            product_order: [],
          });
        }
      };
      loadConfig();
    }
  }, [open, categoryId]);

  // Initialize product order when modal opens AND we have both products and config
  useEffect(() => {
    if (open && products.length > 0 && currentConfig) {
      const existingOrder = currentConfig.product_order || [];
      const allProductIds = products.map((p) => p.id);

      // PRESERVE existing order, append new products at end
      const preservedOrder = existingOrder.filter((id: string) =>
        allProductIds.includes(id)
      );
      const newProducts = allProductIds.filter(
        (id) => !existingOrder.includes(id)
      );

      setProductOrder([...preservedOrder, ...newProducts]);
    }
  }, [open, products, currentConfig]);

  const handleDragEnd = (event: any) => {
    const { active, over } = event;

    if (over && active.id !== over.id) {
      setProductOrder((items) => {
        const oldIndex = items.indexOf(active.id);
        const newIndex = items.indexOf(over.id);
        return arrayMove(items, oldIndex, newIndex);
      });
    }
  };

  const handleSave = async () => {
    const success = await saveSorting();
    if (success) {
      // Reset config to force fresh load next time modal opens
      setCurrentConfig(undefined);
      // Close modal
      onOpenChange(false);
    }
  };

  // Order products based on productOrder array
  const orderedProducts = productOrder
    .map((id) => products.find((p) => p.id === id))
    .filter(Boolean) as typeof products;

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="bg-ui-bg-base rounded-lg shadow-xl w-full h-full max-w-7xl max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-ui-border-base shrink-0">
          <div>
            <Heading level="h2" className="text-ui-fg-base">
              Manage Product Sorting
            </Heading>
            <Text className="text-ui-fg-subtle text-sm mt-1">
              {categoryName} • {products.length} products
            </Text>
          </div>
          <Button
            variant="transparent"
            onClick={() => onOpenChange(false)}
            className="text-ui-fg-subtle hover:text-ui-fg-base"
          >
            <XMark />
          </Button>
        </div>

        {/* Content - Grid Layout */}
        <div className="flex-1 overflow-y-auto p-6">
          {isLoading || !currentConfig ? (
            <div className="flex items-center justify-center py-12">
              <Text className="text-ui-fg-subtle">Loading products...</Text>
            </div>
          ) : products.length === 0 ? (
            <div className="flex items-center justify-center py-12">
              <Text className="text-ui-fg-subtle">
                No products in this category
              </Text>
            </div>
          ) : (
            <div className="space-y-4">
              <Text className="text-ui-fg-subtle text-sm">
                Drag and drop to reorder • {products.length} total
              </Text>
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragEnd={handleDragEnd}
              >
                <SortableContext
                  items={productOrder}
                  strategy={rectSortingStrategy}
                >
                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
                    {orderedProducts.map((product) => (
                      <ProductGridItem
                        key={product.id}
                        id={product.id}
                        name={product.title}
                        thumbnail={product.thumbnail}
                      />
                    ))}
                  </div>
                </SortableContext>
              </DndContext>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 p-6 border-t border-ui-border-base shrink-0">
          <Button
            variant="secondary"
            onClick={() => onOpenChange(false)}
            disabled={isSaving}
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={handleSave}
            disabled={
              isSaving || isLoading || products.length === 0 || !hasChanges
            }
          >
            {isSaving ? "Saving..." : "Save Order"}
          </Button>
        </div>
      </div>
    </div>
  );
};

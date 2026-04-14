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
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { Container, Heading, Text } from "@medusajs/ui";

import { SortableItem } from "./SortableItem";

type Product = {
  id: string;
  title: string;
  handle: string;
  thumbnail?: string;
};

type ProductsListProps = {
  products: Product[];
  order: string[];
  onOrderChange: (order: string[]) => void;
};

export const ProductsList = ({
  products,
  order,
  onOrderChange,
}: ProductsListProps) => {
  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const handleDragEnd = (event: any) => {
    const { active, over } = event;

    if (over && active.id !== over.id) {
      const oldIndex = order.indexOf(active.id);
      const newIndex = order.indexOf(over.id);
      const newOrder = arrayMove(order, oldIndex, newIndex);
      onOrderChange(newOrder);
    }
  };

  // Order products based on order array
  const orderedProducts = order
    .map((id) => products.find((p) => p.id === id))
    .filter(Boolean) as Product[];

  // Add unordered products at the end
  const unorderedProducts = products.filter((p) => !order.includes(p.id));
  const allProducts = [...orderedProducts, ...unorderedProducts];

  console.log("[ProductsList] Order prop:", order);
  console.log(
    "[ProductsList] Ordered items:",
    orderedProducts.map((p) => p.title)
  );
  console.log(
    "[ProductsList] Unordered items:",
    unorderedProducts.map((p) => p.title)
  );
  console.log(
    "[ProductsList] Final render order:",
    allProducts.map((p) => p.title)
  );

  return (
    <Container className="h-full flex flex-col">
      <Heading level="h2" className="mb-4">
        Products
      </Heading>

      {allProducts.length === 0 ? (
        <Text className="text-ui-fg-muted text-sm">
          No products in this category
        </Text>
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={allProducts.map((p) => p.id)}
            strategy={verticalListSortingStrategy}
          >
            <div className="space-y-2 overflow-y-auto flex-1">
              {allProducts.map((product) => (
                <SortableItem
                  key={product.id}
                  id={product.id}
                  name={product.title}
                  subtitle={product.handle}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      )}
    </Container>
  );
};

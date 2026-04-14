import { defineWidgetConfig } from "@medusajs/admin-sdk";
import { ListTree } from "@medusajs/icons";
import { Container, Heading, Button, Text } from "@medusajs/ui";
import { useState } from "react";

import { ManageProductSortingModal } from "../components/manage-product-sorting-modal";

interface CategorySortingWidgetProps {
  data: {
    id: string;
    name: string;
  };
}

/**
 * Widget that appears on the Category Details page (Admin).
 * Opens a modal to manage product sorting for this category.
 */
const CategorySortingWidget = ({ data }: CategorySortingWidgetProps) => {
  const [isModalOpen, setIsModalOpen] = useState(false);

  return (
    <>
      <Container className="p-4 flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-ui-bg-base-hover rounded-md">
            <ListTree className="text-ui-fg-subtle" />
          </div>
          <div>
            <Heading level="h2" className="text-ui-fg-base text-sm font-medium">
              Product Sorting
            </Heading>
            <Text className="text-ui-fg-subtle text-xs">
              Customize the display order of products in this category.
            </Text>
          </div>
        </div>

        <Button
          variant="secondary"
          size="small"
          onClick={() => setIsModalOpen(true)}
        >
          Manage Product Sorting
        </Button>
      </Container>

      <ManageProductSortingModal
        open={isModalOpen}
        onOpenChange={setIsModalOpen}
        categoryId={data.id}
        categoryName={data.name}
      />
    </>
  );
};

export const config = defineWidgetConfig({
  zone: "product_category.details.after",
});

export default CategorySortingWidget;

import { defineWidgetConfig } from "@medusajs/admin-sdk";
import { DetailWidgetProps, AdminProduct } from "@medusajs/framework/types";
import { Container, Heading, Text } from "@medusajs/ui";

import { RelatedProductsEditor } from "../components/related-products/RelatedProductsEditor";

const RelatedProductsWidget = ({ data }: DetailWidgetProps<AdminProduct>) => {
  return (
    <Container className="divide-y p-0">
      <div className="flex flex-col gap-y-1 px-6 py-4">
        <Heading level="h2">Related products</Heading>
        <Text size="small" className="text-ui-fg-subtle">
          Shown on the storefront in this order. Drafts are hidden and
          out-of-stock items sink to the end automatically; the first 4 valid
          ones are displayed. Adding a product here also adds this one to its
          list (you can remove it there later).
        </Text>
      </div>

      <div className="px-6 py-4">
        <RelatedProductsEditor productId={data.id} />
      </div>
    </Container>
  );
};

export const config = defineWidgetConfig({
  zone: "product.details.after",
});

export default RelatedProductsWidget;

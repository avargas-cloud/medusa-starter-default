import { defineWidgetConfig } from "@medusajs/admin-sdk";
import { DetailWidgetProps } from "@medusajs/framework/types";
import { Container, Heading, Switch, Label, Text } from "@medusajs/ui";
import { useState, useEffect } from "react";

type CategoryWithMetadata = {
  id: string;
  name: string;
  metadata?: {
    include_descendants_tree?: boolean;
  };
};

const CategoryIncludeDescendantsWidget = ({
  data,
}: DetailWidgetProps<CategoryWithMetadata>) => {
  // Default to true if not set
  const [includeDescendants, setIncludeDescendants] = useState<boolean>(
    data.metadata?.include_descendants_tree ?? true
  );
  const [isSaving, setIsSaving] = useState(false);

  // Re-initialize when data.metadata changes (e.g., after navigation)
  useEffect(() => {
    setIncludeDescendants(data.metadata?.include_descendants_tree ?? true);
  }, [data.metadata]);

  const handleToggle = async (checked: boolean) => {
    setIncludeDescendants(checked);
    setIsSaving(true);

    try {
      // CRITICAL: Fetch current metadata first to avoid overwriting other fields
      const fetchResponse = await fetch(
        `/admin/product-categories/${data.id}?fields=+metadata`,
        {
          credentials: "include",
        }
      );

      if (!fetchResponse.ok) throw new Error("Failed to fetch category");

      const categoryData = await fetchResponse.json();
      const existingMetadata = categoryData.product_category?.metadata || {};

      const response = await fetch(`/admin/product-categories/${data.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          metadata: {
            ...existingMetadata,
            include_descendants_tree: checked,
          },
        }),
      });

      if (!response.ok) throw new Error("Failed to update category");

      console.log(
        `[DESCENDANTS] Updated category ${data.id}: include_descendants_tree=${checked}`
      );

      // Refresh page to reload category data (required for widget update)
      window.location.reload();
    } catch (error) {
      console.error("[DESCENDANTS] Failed to update:", error);
      // Revert on error
      setIncludeDescendants(!checked);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Container className="divide-y p-0">
      <div className="flex items-center justify-between px-6 py-4">
        <div className="flex-1">
          <Heading level="h2">Include Subcategory Products</Heading>
          <Text className="text-ui-fg-subtle text-sm mt-1">
            Include products from child categories when browsing this category
          </Text>
        </div>
        <div className="flex items-center gap-3">
          <Label htmlFor="category-descendants-toggle" className="text-sm">
            {includeDescendants ? "Yes" : "No"}
          </Label>
          <Switch
            id="category-descendants-toggle"
            checked={includeDescendants}
            onCheckedChange={handleToggle}
            disabled={isSaving}
          />
        </div>
      </div>

      {/* Info section */}
      <div className="px-6 py-3 bg-ui-bg-subtle">
        <Text className="text-xs text-ui-fg-muted">
          <strong>Yes:</strong> Show products from this category AND all
          subcategories
          <br />
          <strong>No:</strong> Show only products directly assigned to this
          category
        </Text>
      </div>
    </Container>
  );
};

export const config = defineWidgetConfig({
  zone: "product_category.details.after",
});

export default CategoryIncludeDescendantsWidget;

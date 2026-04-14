import { defineWidgetConfig } from "@medusajs/admin-sdk";
import { Container, Heading, Switch, Label, Text } from "@medusajs/ui";
import { DetailWidgetProps } from "@medusajs/framework/types";
import { useState, useEffect } from "react";

type CategoryWithMetadata = {
  id: string;
  name: string;
  metadata?: {
    prerender?: boolean;
  };
};

const CategoryPrerenderWidget = ({
  data,
}: DetailWidgetProps<CategoryWithMetadata>) => {
  const [prerender, setPrerender] = useState<boolean>(
    data.metadata?.prerender === true
  );
  const [isSaving, setIsSaving] = useState(false);

  // Re-initialize when data.metadata changes (e.g., after navigation)
  useEffect(() => {
    setPrerender(data.metadata?.prerender === true);
  }, [data.metadata]);

  const handleToggle = async (checked: boolean) => {
    setPrerender(checked);
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
            prerender: checked,
          },
        }),
      });

      if (!response.ok) throw new Error("Failed to update category");

      console.log(
        `[PRE-RENDER] Updated category ${data.id}: prerender=${checked}`
      );

      // Refresh page to reload category data (required for widget update)
      // Matches pattern from category-filters-widget
      window.location.reload();
    } catch (error) {
      console.error("[PRE-RENDER] Failed to update:", error);
      // Revert on error
      setPrerender(!checked);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Container className="divide-y p-0">
      <div className="flex items-center justify-between px-6 py-4">
        <div className="flex-1">
          <Heading level="h2">Pre-Render</Heading>
          <Text className="text-ui-fg-subtle text-sm mt-1">
            Enable static page generation for this category
          </Text>
        </div>
        <div className="flex items-center gap-3">
          <Label htmlFor="category-prerender-toggle" className="text-sm">
            {prerender ? "Yes" : "No"}
          </Label>
          <Switch
            id="category-prerender-toggle"
            checked={prerender}
            onCheckedChange={handleToggle}
            disabled={isSaving}
          />
        </div>
      </div>

      {/* Info section */}
      <div className="px-6 py-3 bg-ui-bg-subtle">
        <Text className="text-xs text-ui-fg-muted">
          <strong>Yes:</strong> Generate static page at build time (faster load)
          <br />
          <strong>No:</strong> Hybrid rendering (dynamic content on each visit)
        </Text>
      </div>
    </Container>
  );
};

export const config = defineWidgetConfig({
  zone: "product_category.details.after",
});

export default CategoryPrerenderWidget;

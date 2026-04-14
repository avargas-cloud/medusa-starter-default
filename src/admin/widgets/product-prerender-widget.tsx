import { defineWidgetConfig } from "@medusajs/admin-sdk";
import { DetailWidgetProps, AdminProduct } from "@medusajs/framework/types";
import { Container, Heading, Switch, Label, Text } from "@medusajs/ui";
import { useState, useEffect } from "react";

type ProductWithMetadata = AdminProduct & {
  metadata?: {
    prerender?: boolean;
  };
};

const ProductPrerenderWidget = ({
  data,
}: DetailWidgetProps<ProductWithMetadata>) => {
  const [prerender, setPrerender] = useState<boolean>(false);
  const [isSaving, setIsSaving] = useState(false);

  // Initialize from metadata
  useEffect(() => {
    if (data.metadata?.prerender !== undefined) {
      setPrerender(data.metadata.prerender === true);
    }
  }, [data.metadata]);

  const handleToggle = async (checked: boolean) => {
    setPrerender(checked);
    setIsSaving(true);

    try {
      const response = await fetch(`/admin/products/${data.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          metadata: {
            ...data.metadata,
            prerender: checked,
          },
        }),
      });

      if (!response.ok) throw new Error("Failed to update product");

      console.log(
        `[PRE-RENDER] Updated product ${data.id}: prerender=${checked}`
      );

      // Refresh page to show updated data
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
            Enable static page generation for this product
          </Text>
        </div>
        <div className="flex items-center gap-3">
          <Label htmlFor="prerender-toggle" className="text-sm">
            {prerender ? "Yes" : "No"}
          </Label>
          <Switch
            id="prerender-toggle"
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
  zone: "product.details.after",
});

export default ProductPrerenderWidget;

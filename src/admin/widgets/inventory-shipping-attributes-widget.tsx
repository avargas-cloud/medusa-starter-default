import { defineWidgetConfig } from "@medusajs/admin-sdk";
import {
  Container,
  Heading,
  Button,
  Input,
  Label,
  Text,
  toast,
} from "@medusajs/ui";
import { useState } from "react";
import { sdk } from "../../lib/sdk";

interface InventoryItem {
  id: string;
  title?: string;
  sku?: string;
  weight?: number | null;
  height?: number | null;
  width?: number | null;
  length?: number | null;
}

interface Props {
  data: InventoryItem;
}

const InventoryShippingAttributesWidget = ({ data }: Props) => {
  const [weight, setWeight] = useState<string>(
    data.weight != null ? String(data.weight) : ""
  );
  const [height, setHeight] = useState<string>(
    data.height != null ? String(data.height) : ""
  );
  const [width, setWidth] = useState<string>(
    data.width != null ? String(data.width) : ""
  );
  const [length, setLength] = useState<string>(
    data.length != null ? String(data.length) : ""
  );
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  const handleChange =
    (setter: (v: string) => void) =>
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setter(e.target.value);
      setDirty(true);
    };

  const handleSave = async () => {
    setSaving(true);
    try {
      await sdk.client.fetch(`/admin/inventory-items/${data.id}`, {
        method: "POST",
        body: {
          weight: weight !== "" ? parseFloat(weight) : null,
          height: height !== "" ? parseFloat(height) : null,
          width: width !== "" ? parseFloat(width) : null,
          length: length !== "" ? parseFloat(length) : null,
        },
      });
      setDirty(false);
      toast.success("Shipping attributes saved");
    } catch (err: any) {
      console.error("[ShippingAttributes] Save failed:", err);
      toast.error("Failed to save: " + (err?.message || "Unknown error"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Container className="p-0">
      <div className="flex items-center justify-between px-6 py-4 border-b border-ui-border-base">
        <Heading level="h2">Shipping Attributes</Heading>
        {dirty && (
          <Button
            variant="primary"
            size="small"
            onClick={handleSave}
            isLoading={saving}
          >
            Save
          </Button>
        )}
      </div>

      <div className="px-6 py-5 grid grid-cols-2 gap-x-6 gap-y-4">
        {/* Weight */}
        <div className="flex flex-col gap-1">
          <Label size="small" weight="plus">
            Weight (lbs)
          </Label>
          <Input
            type="number"
            step="any"
            min="0"
            placeholder="e.g. 0.31"
            value={weight}
            onChange={handleChange(setWeight)}
          />
        </div>

        {/* Length */}
        <div className="flex flex-col gap-1">
          <Label size="small" weight="plus">
            Length (in)
          </Label>
          <Input
            type="number"
            step="any"
            min="0"
            placeholder="e.g. 14.18"
            value={length}
            onChange={handleChange(setLength)}
          />
        </div>

        {/* Width */}
        <div className="flex flex-col gap-1">
          <Label size="small" weight="plus">
            Width (in)
          </Label>
          <Input
            type="number"
            step="any"
            min="0"
            placeholder="e.g. 7.87"
            value={width}
            onChange={handleChange(setWidth)}
          />
        </div>

        {/* Height */}
        <div className="flex flex-col gap-1">
          <Label size="small" weight="plus">
            Height (in)
          </Label>
          <Input
            type="number"
            step="any"
            min="0"
            placeholder="e.g. 6.29"
            value={height}
            onChange={handleChange(setHeight)}
          />
        </div>
      </div>

      {/* Info note */}
      <div className="px-6 pb-4">
        <Text size="xsmall" className="text-ui-fg-subtle">
          These values are used for UPS shipping rate calculations. Decimals are
          supported.
        </Text>
      </div>
    </Container>
  );
};

export const config = defineWidgetConfig({
  zone: "inventory_item.details.after",
});

export default InventoryShippingAttributesWidget;

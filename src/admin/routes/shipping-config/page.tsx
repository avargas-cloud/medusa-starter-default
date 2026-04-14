import { defineRouteConfig } from "@medusajs/admin-sdk";
import { TruckFast } from "@medusajs/icons";
import {
  Container,
  Heading,
  Button,
  Input,
  Label,
  Text,
  toast,
  Switch,
} from "@medusajs/ui";
import { useState, useEffect } from "react";

const ShippingConfigPage = () => {
  const [loading, setLoading] = useState(false);
  const [freeShippingMin, setFreeShippingMin] = useState("");
  const [regularGroundPrice, setRegularGroundPrice] = useState("");
  const [longItemPrice, setLongItemPrice] = useState("");
  const [overrideUpsGround, setOverrideUpsGround] = useState(false);

  useEffect(() => {
    const loadSettings = async () => {
      try {
        const res = await fetch("/admin/shipping-settings", {
          method: "GET",
          credentials: "include",
        });
        if (!res.ok) return;
        const { settings } = await res.json();
        setFreeShippingMin((settings.free_shipping_minimum / 100).toFixed(2));
        setRegularGroundPrice(
          (settings.regular_ground_shipping_price / 100).toFixed(2)
        );
        setLongItemPrice(
          (settings.long_item_ground_shipping_price / 100).toFixed(2)
        );
        setOverrideUpsGround(settings.override_ups_ground || false);
      } catch (error) {
        console.error("Failed to load settings:", error);
      }
    };
    loadSettings();
  }, []);

  const handleSave = async () => {
    const freeShipNum =
      freeShippingMin === "" ? 0 : parseFloat(freeShippingMin);
    const regularNum =
      regularGroundPrice === "" ? 0 : parseFloat(regularGroundPrice);
    const longNum = longItemPrice === "" ? 0 : parseFloat(longItemPrice);

    if (overrideUpsGround) {
      if (isNaN(freeShipNum) || freeShipNum < 0) {
        toast.error("Validation Error", {
          description:
            "Free shipping minimum must be a valid non-negative number",
        });
        return;
      }
      if (isNaN(regularNum) || regularNum < 0) {
        toast.error("Validation Error", {
          description:
            "Regular ground shipping price must be a valid non-negative number",
        });
        return;
      }
      if (isNaN(longNum) || longNum < 0) {
        toast.error("Validation Error", {
          description:
            "Long item ground shipping price must be a valid non-negative number",
        });
        return;
      }
    }

    setLoading(true);
    try {
      const res = await fetch("/admin/shipping-settings", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          free_shipping_minimum: Math.round(freeShipNum * 100),
          regular_ground_shipping_price: Math.round(regularNum * 100),
          long_item_ground_shipping_price: Math.round(longNum * 100),
          override_ups_ground: overrideUpsGround,
        }),
      });

      if (!res.ok) {
        const errorData = await res.json();
        toast.error("Failed to save settings", {
          description: errorData.error || "Unknown error occurred",
        });
        return;
      }

      toast.success("Settings saved", {
        description: `Free shipping at $${freeShipNum.toFixed(2)} • Ground: $${regularNum.toFixed(2)} • Long items: $${longNum.toFixed(2)}`,
      });
    } catch (error) {
      toast.error("Failed to save settings", {
        description: error instanceof Error ? error.message : "Unknown error",
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-col gap-3 p-6 max-w-2xl">
      <div>
        <Heading level="h1">Shipping Settings</Heading>
      </div>

      {/* ─── Master toggle ─── */}
      <Container>
        <div className="p-4">
          <div className="flex items-center justify-between">
            <div>
              <Heading level="h3" className="text-sm font-medium">
                🚚 Override UPS Ground Shipping
              </Heading>
              <Text className="text-xs text-ui-fg-subtle mt-1">
                When <strong>enabled</strong>, use custom fixed pricing based on
                order total and item types. When <strong>disabled</strong>, use
                UPS native Ground service with real-time rates.
              </Text>
            </div>
            <div className="flex items-center gap-3 ml-4 shrink-0">
              <Text
                className={`text-xs font-semibold ${overrideUpsGround ? "text-green-600" : "text-ui-fg-muted"}`}
              >
                {overrideUpsGround ? "Enabled" : "Disabled"}
              </Text>
              <Switch
                id="override-ups-ground"
                checked={overrideUpsGround}
                onCheckedChange={setOverrideUpsGround}
              />
            </div>
          </div>
          {!overrideUpsGround && (
            <div className="mt-3 p-2 rounded bg-ui-bg-subtle border border-ui-border-base">
              <Text className="text-xs text-ui-fg-subtle">
                ℹ️ Using UPS real-time rates. Enable override to set custom
                shipping prices below.
              </Text>
            </div>
          )}
        </div>
      </Container>

      {/* ─── Free Shipping ─── */}
      <Container>
        <div className="p-4 space-y-3">
          <Heading level="h3" className="text-sm font-medium">
            🎁 Free Shipping
          </Heading>
          <div>
            <Label htmlFor="free-shipping-min" className="mb-1 block text-xs">
              Minimum Order Amount ($)
            </Label>
            <Input
              id="free-shipping-min"
              type="number"
              min="0"
              step="0.01"
              value={freeShippingMin}
              onChange={(e) => setFreeShippingMin(e.target.value)}
              placeholder="0.00"
              disabled={!overrideUpsGround}
            />
            <Text size="small" className="text-ui-fg-subtle mt-1">
              Orders above this amount qualify for free shipping
            </Text>
          </div>
        </div>
      </Container>

      {/* ─── Regular Ground ─── */}
      <Container>
        <div className="p-4 space-y-3">
          <Heading level="h3" className="text-sm font-medium">
            📦 Regular Ground Shipping
          </Heading>
          <div>
            <Label
              htmlFor="regular-ground-price"
              className="mb-1 block text-xs"
            >
              Price for Regular Items ($)
            </Label>
            <Input
              id="regular-ground-price"
              type="number"
              min="0"
              step="0.01"
              value={regularGroundPrice}
              onChange={(e) => setRegularGroundPrice(e.target.value)}
              placeholder="0.00"
              disabled={!overrideUpsGround}
            />
            <Text size="small" className="text-ui-fg-subtle mt-1">
              Flat shipping rate for regular items
            </Text>
          </div>
        </div>
      </Container>

      {/* ─── Long Item Ground ─── */}
      <Container>
        <div className="p-4 space-y-3">
          <Heading level="h3" className="text-sm font-medium">
            📏 Long Item Ground Shipping
          </Heading>
          <div>
            <Label htmlFor="long-item-price" className="mb-1 block text-xs">
              Price for Long Items ($)
            </Label>
            <Input
              id="long-item-price"
              type="number"
              min="0"
              step="0.01"
              value={longItemPrice}
              onChange={(e) => setLongItemPrice(e.target.value)}
              placeholder="0.00"
              disabled={!overrideUpsGround}
            />
            <Text size="small" className="text-ui-fg-subtle mt-1">
              Flat rate when order contains items with long shipping profile
            </Text>
          </div>
          <div className="pt-2 border-t border-ui-border-base flex justify-end">
            <Button onClick={handleSave} isLoading={loading} disabled={loading}>
              Save Settings
            </Button>
          </div>
        </div>
      </Container>
    </div>
  );
};

export const config = defineRouteConfig({
  label: "Shipping",
  icon: TruckFast,
});

export default ShippingConfigPage;

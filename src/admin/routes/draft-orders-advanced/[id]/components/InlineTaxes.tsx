import { Text, Badge, toast } from "@medusajs/ui";
import { useState, useEffect, useCallback } from "react";

import { fmt } from "../helpers";

type TaxMode = "florida" | "exempt" | "auto";

interface TaxResult {
  amount: number;
  rate: number;
  reason: string;
  exempt: boolean;
  mode: TaxMode;
  autoMode: TaxMode;
  subtotal: number;
  shippingSubtotal: number;
}

interface Props {
  orderId: string;
  curr: string;
  triggerKey?: any;
  onTaxChange?: (amount: number) => void;
  /** Called with the effective rate % (e.g. 7 for 7%) whenever tax is computed */
  onTaxRateChange?: (rate: number) => void;
}

const MODE_LABELS: Record<TaxMode, string> = {
  florida: "Florida (7%)",
  exempt: "Tax Exempt",
  auto: "Auto",
};

export const InlineTaxes = ({
  orderId,
  curr,
  triggerKey,
  onTaxChange,
  onTaxRateChange,
}: Props) => {
  const [tax, setTax] = useState<TaxResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const fetchTax = useCallback(async () => {
    if (!orderId) return;
    setLoading(true);
    try {
      const r = await fetch(`/admin/draft-orders/${orderId}/compute-tax`, {
        credentials: "include",
      });
      if (r.ok) {
        const data: TaxResult = await r.json();
        setTax(data);
        onTaxChange?.(data.amount);
        onTaxRateChange?.(data.exempt ? 0 : (data.rate ?? 0));
      }
    } catch {
      /* silent */
    } finally {
      setLoading(false);
    }
  }, [orderId, onTaxChange]);

  useEffect(() => {
    fetchTax();
  }, [fetchTax, triggerKey]);

  const handleModeChange = async (newMode: TaxMode) => {
    if (!tax || newMode === tax.mode) return;
    // Optimistic update — FL taxes items ONLY (shipping is not taxed)
    const prevTax = tax;
    const taxableBase = tax.subtotal ?? 0;
    const optimisticAmount =
      newMode === "exempt"
        ? 0
        : newMode === "florida"
          ? Math.round(((taxableBase * 7) / 100) * 100) / 100
          : tax.amount;
    setTax((prev) =>
      prev
        ? {
            ...prev,
            mode: newMode,
            amount: optimisticAmount,
            exempt: newMode === "exempt",
          }
        : prev
    );
    onTaxChange?.(optimisticAmount);
    onTaxRateChange?.(newMode === "exempt" ? 0 : 7);

    setSaving(true);
    try {
      const r = await fetch(`/admin/draft-orders/${orderId}/compute-tax`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: newMode }),
      });
      if (!r.ok) throw new Error("Failed to update tax mode");
      // Re-fetch to get server-computed amount with exact rate
      await fetchTax();
    } catch (e: any) {
      setTax(prevTax);
      onTaxChange?.(prevTax.amount);
      toast.error(e.message);
    } finally {
      setSaving(false);
    }
  };

  if (loading && !tax) {
    return (
      <div className="px-6 py-4">
        <Text size="small" className="text-ui-fg-muted">
          Computing taxes...
        </Text>
      </div>
    );
  }

  const currentMode: TaxMode = tax?.mode ?? "auto";
  const modes: TaxMode[] = ["florida", "exempt"];

  return (
    <div className="px-6 py-4 flex items-center justify-between">
      <div className="flex items-center gap-2">
        {/* Mode selector — segmented button group */}
        <div className="flex rounded-md border border-ui-border-base overflow-hidden text-xs">
          {modes.map((m) => (
            <button
              key={m}
              disabled={saving || loading}
              onClick={() => handleModeChange(m)}
              className={`px-3 py-1.5 transition-colors disabled:opacity-50 ${
                currentMode === m
                  ? m === "exempt"
                    ? "bg-ui-tag-green-bg text-ui-tag-green-text font-medium"
                    : "bg-ui-bg-interactive text-ui-fg-on-color font-medium"
                  : "bg-ui-bg-base text-ui-fg-subtle hover:bg-ui-bg-subtle"
              }`}
            >
              {MODE_LABELS[m]}
            </button>
          ))}
        </div>
        {saving && (
          <Text size="xsmall" className="text-ui-fg-muted">
            Saving...
          </Text>
        )}
        {tax && !saving && (
          <Text size="xsmall" className="text-ui-fg-muted">
            {tax.exempt ? (
              <Badge color="green" size="small">
                Exempt
              </Badge>
            ) : (
              tax.reason
            )}
          </Text>
        )}
      </div>
      <Text size="small" weight="plus">
        {tax ? fmt(tax.amount, curr) : "—"}
      </Text>
    </div>
  );
};

import { Trash } from "@medusajs/icons";
import { Container, Heading, Badge, Text, toast } from "@medusajs/ui";
import { useState } from "react";

import { fmt } from "../helpers";

import { InlinePromoInput } from "./InlinePromoInput";

interface Props {
  orderId: string;
  promotions: any[];
  discountTotal: number;
  curr: string;
  onApplied: () => void;
}

export const PromotionsBlock = ({
  orderId,
  promotions,
  discountTotal,
  curr,
  onApplied,
}: Props) => {
  const [removingId, setRemovingId] = useState<string | null>(null);

  const handleRemove = async (promoId: string) => {
    if (removingId) return;
    setRemovingId(promoId);
    try {
      // Unlink promotion from the order
      const r = await fetch(`/admin/orders/${orderId}/promotions/${promoId}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.message || `HTTP ${r.status}`);
      }
      toast.success("Promotion removed");
      onApplied();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setRemovingId(null);
    }
  };

  return (
    <Container className="p-0 overflow-hidden">
      <div className="px-6 py-4">
        <div className="flex items-center gap-2 mb-3">
          <Heading level="h2">Promotions</Heading>
          {promotions.length > 0 && (
            <Badge color="blue" size="small">
              {promotions.length}
            </Badge>
          )}
        </div>
        <InlinePromoInput
          orderId={orderId}
          onApplied={onApplied}
          appliedCodes={promotions.map((p) => p.code)}
        />
        {promotions.length > 0 && (
          <div className="mt-3 space-y-1.5">
            {promotions.map((p: any) => (
              <div
                key={p.id}
                className="flex items-center justify-between bg-ui-bg-subtle rounded px-3 py-2 group"
              >
                <div className="flex items-center gap-2">
                  <Badge color="purple" size="small">
                    {p.code ?? "PROMO"}
                  </Badge>
                  <Text size="xsmall" className="text-ui-fg-subtle">
                    {p.application_method?.type === "percentage"
                      ? `${p.application_method.value}% off`
                      : p.application_method?.type === "fixed"
                        ? `-$${p.application_method.value}`
                        : (p.type ?? "")}
                  </Text>
                </div>
                <div className="flex items-center gap-3">
                  {discountTotal > 0 && (
                    <Text size="small" className="text-ui-fg-base font-medium">
                      -{fmt(discountTotal, curr)}
                    </Text>
                  )}
                  <button
                    onClick={() => handleRemove(p.id)}
                    disabled={!!removingId}
                    className="text-ui-fg-muted hover:text-ui-fg-base disabled:opacity-50 transition-colors opacity-0 group-hover:opacity-100"
                    title="Remove promotion"
                  >
                    {removingId === p.id ? (
                      <svg
                        className="animate-spin h-4 w-4"
                        fill="none"
                        viewBox="0 0 24 24"
                      >
                        <circle
                          className="opacity-25"
                          cx="12"
                          cy="12"
                          r="10"
                          stroke="currentColor"
                          strokeWidth="4"
                        />
                        <path
                          className="opacity-75"
                          fill="currentColor"
                          d="M4 12a8 8 0 018-8v8H4z"
                        />
                      </svg>
                    ) : (
                      <Trash className="w-4 h-4" />
                    )}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </Container>
  );
};

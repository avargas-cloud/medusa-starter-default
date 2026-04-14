import { useState, useCallback, useEffect } from "react";
import { PriceOption } from "../components/PriceCombobox";

/**
 * Fetches customer-specific prices for all variants in the order
 * using /admin/draft-orders/:id/variant-prices (Medusa module-based, reliable).
 */
export const useOrderPageState = (
  order: any | null,
  handleAddShipping: () => Promise<void>,
  handleReplaceShipping?: (
    oldId: string,
    newOptionId: string,
    customAmount?: string
  ) => Promise<void>,
  handleUpdateShippingAmount?: (
    methodId: string,
    optionId: string,
    newAmount: number,
    onShippingChanged?: () => void
  ) => Promise<void>
) => {
  const orderId: string = order?.id ?? "";
  const [customerPrices, setCustomerPrices] = useState<
    Record<string, PriceOption[]>
  >({});
  const [inlineShippingOptions, setInlineShippingOptions] = useState<
    { id: string; name: string; amount: number | null }[]
  >([]);

  useEffect(() => {
    if (!orderId) return;
    const items: any[] = order?.items ?? [];
    const variantIds = [
      ...new Set(
        items.map((i: any) => i.variant?.id ?? i.variant_id).filter(Boolean)
      ),
    ];
    if (variantIds.length === 0) return;
    (async () => {
      try {
        // Use backend endpoint that resolves via Medusa pricing module
        // Always fetches all price lists (Default + Wholesale) regardless of customer
        const qs = variantIds
          .map((id) => `variant_ids[]=${encodeURIComponent(id)}`)
          .join("&");
        const r = await fetch(
          `/admin/draft-orders/${orderId}/variant-prices?${qs}`,
          { credentials: "include" }
        );
        if (!r.ok) return;
        const { prices } = await r.json();

        const priceMap: Record<string, PriceOption[]> = {};
        for (const [variantId, entry] of Object.entries(
          prices as Record<string, any>
        )) {
          const opts: PriceOption[] = [];
          if (entry?.default) {
            // Medusa v2 REST API returns amounts already in major units (dollars)
            opts.push({ label: "Default", amount: entry.default.amount });
          }
          for (const lp of entry?.list ?? []) {
            // Shorten "Wholesale Price" → "Wholesale", etc.
            const rawLabel: string = lp.price_list_name ?? "Price List";
            const shortLabel =
              rawLabel.replace(/\s+Price(s)?$/i, "").trim() || rawLabel;
            opts.push({
              label: shortLabel,
              amount: lp.amount,
              priceListId: lp.price_list_id,
            });
          }
          if (opts.length > 0) priceMap[variantId] = opts;
        }
        setCustomerPrices(priceMap);
      } catch {
        /* best-effort */
      }
    })();
  }, [orderId, order?.items?.length]);

  const loadShippingOptions = useCallback(async (): Promise<
    { id: string; name: string; amount: number | null }[]
  > => {
    const r = await fetch("/admin/shipping-options", {
      credentials: "include",
    });
    if (r.ok) {
      const j = await r.json();
      const opts = (j.shipping_options ?? []).map((o: any) => ({
        id: o.id,
        name: o.name,
        amount: typeof o.amount === "number" ? o.amount : null,
      }));
      setInlineShippingOptions(opts);
      return opts;
    }
    return [];
  }, []);

  const handleAddShippingInline = useCallback(
    async (optionId: string, customAmount?: string) => {
      await (
        handleAddShipping as (id: string, amount?: string) => Promise<void>
      )(optionId, customAmount);
    },
    [handleAddShipping]
  );

  const handleReplaceShippingInline = useCallback(
    async (oldMethodId: string, newOptionId: string, customAmount?: string) => {
      await handleReplaceShipping?.(oldMethodId, newOptionId, customAmount);
    },
    [handleReplaceShipping]
  );

  const handleUpdateShippingAmountInline = useCallback(
    async (
      methodId: string,
      optionId: string,
      newAmount: number,
      onShippingChanged?: () => void
    ) => {
      await handleUpdateShippingAmount?.(
        methodId,
        optionId,
        newAmount,
        onShippingChanged
      );
    },
    [handleUpdateShippingAmount]
  );

  return {
    customerPrices,
    inlineShippingOptions,
    loadShippingOptions,
    handleAddShippingInline,
    handleReplaceShippingInline,
    handleUpdateShippingAmountInline,
  };
};

import { toast } from "@medusajs/ui";
import { DraftOrderDetail } from "../types";

interface Deps {
  id: string | undefined;
  setOrder: React.Dispatch<React.SetStateAction<DraftOrderDetail | null>>;
  selectedOption: string;
  customAmount: string;
  saving: boolean;
  setSaving: (v: boolean) => void;
  closeModal: () => void;
}

/** Fallback pickup/warehouse address */
const FALLBACK_ADDR = {
  first_name: "Ecopowertech",
  last_name: "Inc",
  company: "Ecopowertech Inc",
  address_1: "2760 W 84th St",
  address_2: "Unit 4",
  city: "Hialeah",
  province: "FL",
  postal_code: "33016",
  country_code: "us",
  phone: "",
};

/** Owns add/remove shipping logic with optimistic state updates. */
export const useOrderShipping = ({
  id,
  setOrder,
  selectedOption,
  customAmount,
  setSaving,
  closeModal,
}: Deps) => {
  /**
   * Optimistically adds a shipping method to the UI instantly,
   * then persists to server in background.
   */
  const handleAddShipping = async (
    optionId?: string,
    customAmountStr?: string
  ): Promise<void> => {
    const resolvedOption = optionId ?? selectedOption;
    const resolvedAmount =
      customAmountStr !== undefined ? customAmountStr : customAmount;
    if (!resolvedOption) {
      toast.error("Select a shipping option");
      return;
    }

    const parsedCustom = resolvedAmount ? parseFloat(resolvedAmount) : NaN;
    const body: Record<string, any> = { shipping_option_id: resolvedOption };
    if (!isNaN(parsedCustom) && parsedCustom >= 0)
      body.custom_amount = parsedCustom;

    // ── 1. Fetch option details FIRST so we can do instant optimistic add ──
    setSaving(true);
    try {
      const shippingOptRes = await fetch(
        `/admin/shipping-options/${resolvedOption}`,
        { credentials: "include" }
      ).catch(() => null);
      const shipping_option = shippingOptRes?.ok
        ? (await shippingOptRes.json()).shipping_option
        : null;
      const optName: string = (
        shipping_option?.name ?? "Shipping"
      ).toLowerCase();
      const newAmount =
        !isNaN(parsedCustom) && parsedCustom >= 0
          ? parsedCustom
          : (shipping_option?.amount ?? 0);
      const tempId = `optimistic-${Date.now()}`;

      // ── 2. Instant optimistic add ──
      setOrder((prev) =>
        prev
          ? {
              ...prev,
              shipping_methods: [
                ...(prev.shipping_methods ?? []),
                {
                  id: tempId,
                  name: shipping_option?.name ?? "Shipping",
                  amount: newAmount,
                  shipping_option_id: resolvedOption,
                  data: {},
                },
              ],
              shipping_total: (prev.shipping_total ?? 0) + newAmount,
            }
          : prev
      );

      toast.success("Shipping method added");
      closeModal();

      // ── 3. Persist to server (background) ──
      (async () => {
        try {
          const r = await fetch(
            `/admin/draft-orders/${id}/add-shipping-force`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              credentials: "include",
              body: JSON.stringify(body),
            }
          );
          if (!r.ok) {
            const j = await r.json().catch(() => ({}));
            toast.error(
              `Shipping save failed: ${j.message || `HTTP ${r.status}`}`
            );
            // Roll back optimistic add
            setOrder((prev) =>
              prev
                ? {
                    ...prev,
                    shipping_methods: (prev.shipping_methods ?? []).filter(
                      (m) => m.id !== tempId
                    ),
                    shipping_total: Math.max(
                      0,
                      (prev.shipping_total ?? 0) - newAmount
                    ),
                  }
                : prev
            );
            return;
          }

          // Swap optimistic ID with real one
          const freshR = await fetch(
            `/admin/orders/${id}?fields=+shipping_methods.*`,
            { credentials: "include" }
          ).catch(() => null);
          if (freshR?.ok) {
            const { order: freshOrder } = await freshR.json();
            const freshMethods: any[] = freshOrder?.shipping_methods ?? [];
            if (freshMethods.length > 0) {
              setOrder((prev) =>
                prev ? { ...prev, shipping_methods: freshMethods } : prev
              );
            }
          }

          // ── 4. For pickup/warehouse: auto-set shipping address ──
          if (
            optName.includes("pickup") ||
            optName.includes("store") ||
            optName.includes("warehouse")
          ) {
            // Use fallback address directly (stock-locations endpoint returns 500 in some envs)
            await fetch(`/admin/draft-orders/${id}`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              credentials: "include",
              body: JSON.stringify({ shipping_address: FALLBACK_ADDR }),
            }).catch((e) => console.warn("[pickup] address update failed:", e));
            setOrder((prev) =>
              prev ? { ...prev, shipping_address: FALLBACK_ADDR as any } : prev
            );
          }
        } catch (e: any) {
          console.warn("[handleAddShipping background]", e?.message);
        }
      })();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setSaving(false);
    }
  };

  const handleRemoveShipping = (methodId: string) => {
    setOrder((prev) => {
      if (!prev) return prev;
      const removed = (prev.shipping_methods ?? []).find(
        (m: any) => m.id === methodId
      );
      return {
        ...prev,
        shipping_methods: (prev.shipping_methods ?? []).filter(
          (m: any) => m.id !== methodId
        ),
        shipping_total: Math.max(
          0,
          (prev.shipping_total ?? 0) - (removed?.amount ?? 0)
        ),
      };
    });
  };

  /**
   * Atomically replace an existing shipping method with a new one.
   */
  const handleReplaceShipping = async (
    oldMethodId: string,
    newOptionId: string,
    customAmountStr?: string
  ): Promise<void> => {
    // 1. Optimistic: remove old
    handleRemoveShipping(oldMethodId);
    setSaving(true);
    try {
      // 2. Server: delete old
      const delRes = await fetch(
        `/admin/draft-orders/${id}/remove-shipping/${oldMethodId}`,
        {
          method: "DELETE",
          credentials: "include",
        }
      );
      if (!delRes.ok) {
        const j = await delRes.json().catch(() => ({}));
        throw new Error(j.message || `Delete failed: HTTP ${delRes.status}`);
      }

      // 3. Server: add new (reuse handleAddShipping for consistent logic)
      await handleAddShipping(newOptionId, customAmountStr);
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setSaving(false);
    }
  };

  /**
   * Update the custom amount of an existing shipping method.
   *
   * UI: patches the amount in-place (no flicker, no remove/re-add visible).
   * Server: does remove + re-add in background.
   * onShippingChanged is called AFTER server confirms the new amount,
   * so the tax re-fetch sees the updated value.
   */
  const handleUpdateShippingAmount = async (
    methodId: string,
    shippingOptionId: string,
    newAmount: number,
    onShippingChanged?: () => void
  ): Promise<void> => {
    // ── 1. Patch amount in-place in UI (no removal flicker) ──
    setOrder((prev) =>
      prev
        ? {
            ...prev,
            shipping_methods: (prev.shipping_methods ?? []).map((m: any) =>
              m.id === methodId ? { ...m, amount: newAmount } : m
            ),
            shipping_total: (prev.shipping_methods ?? []).reduce(
              (sum: number, m: any) =>
                sum + (m.id === methodId ? newAmount : (m.amount ?? 0)),
              0
            ),
          }
        : prev
    );

    setSaving(true);
    try {
      // ── 2. Server: delete old method ──
      const delRes = await fetch(
        `/admin/draft-orders/${id}/remove-shipping/${methodId}`,
        {
          method: "DELETE",
          credentials: "include",
        }
      );
      if (!delRes.ok) {
        const j = await delRes.json().catch(() => ({}));
        throw new Error(j.message || `Delete failed: HTTP ${delRes.status}`);
      }

      // ── 3. Server: re-add with new amount ──
      const body = {
        shipping_option_id: shippingOptionId,
        custom_amount: newAmount,
      };
      const addRes = await fetch(
        `/admin/draft-orders/${id}/add-shipping-force`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify(body),
        }
      );
      if (!addRes.ok) {
        const j = await addRes.json().catch(() => ({}));
        throw new Error(j.message || `Add failed: HTTP ${addRes.status}`);
      }

      // ── 4. Server confirmed — NOW trigger tax re-fetch (sees new amount) ──
      onShippingChanged?.();

      // ── 5. Swap temp method ID with real one in background ──
      setTimeout(async () => {
        try {
          const freshR = await fetch(
            `/admin/orders/${id}?fields=+shipping_methods.*`,
            { credentials: "include" }
          );
          if (freshR.ok) {
            const { order: freshOrder } = await freshR.json();
            const freshMethods: any[] = freshOrder?.shipping_methods ?? [];
            if (freshMethods.length > 0) {
              setOrder((prev) =>
                prev ? { ...prev, shipping_methods: freshMethods } : prev
              );
            }
          }
        } catch {}
      }, 1000);
    } catch (e: any) {
      toast.error(e.message);
      // Roll back the optimistic amount patch
      setOrder((prev) =>
        prev
          ? {
              ...prev,
              shipping_methods: (prev.shipping_methods ?? []).map((m: any) =>
                m.id === methodId
                  ? { ...m, amount: m._originalAmount ?? m.amount }
                  : m
              ),
            }
          : prev
      );
    } finally {
      setSaving(false);
    }
  };

  return {
    handleAddShipping,
    handleRemoveShipping,
    handleReplaceShipping,
    handleUpdateShippingAmount,
  };
};

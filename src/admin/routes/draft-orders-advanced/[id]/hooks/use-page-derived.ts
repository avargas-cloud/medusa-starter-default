// usePageDerived — page-level state and derived logic for the DraftOrderDetail page.
import { useState, useCallback, useEffect, useRef } from "react";

import type { EstimateInfo } from "../components/EstimateInfoBlock";
import { getMissingEstimateFields } from "../components/EstimateInfoBlock";
import type { InlineShippingHandle } from "../components/InlineShipping";
import type { DraftOrderDetail } from "../types";

interface Deps {
  id: string | undefined;
  order: DraftOrderDetail | null;
  estimateStatus: string;
  itemPrices: Record<string, string>;
  itemQtys: Record<string, number>;
  handleAddItem: (variantId: string, overridePrice?: number) => Promise<void>;
  handleUpdateItem: (itemId: string) => Promise<void>;
  handleRemoveItem: (itemId: string) => Promise<void>;
  handleConvert: () => void;
  handleStatusChange: (val: string) => void;
  addTimelineEvent: (
    title: string,
    description?: string,
    user?: string
  ) => void;
  currentUser: string;
}

export const usePageDerived = ({
  id,
  order,
  estimateStatus,
  itemPrices,
  itemQtys,
  handleAddItem,
  handleUpdateItem,
  handleRemoveItem,
  handleConvert,
  handleStatusChange,
  addTimelineEvent,
  currentUser,
}: Deps) => {
  // ── Tax state ─────────────────────────────────────────────────────────────
  const [taxAmount, setTaxAmount] = useState(0);
  const [taxRate, setTaxRate] = useState<number | undefined>(undefined);
  const taxInitialized = useRef(false);
  // Seed from server immediately to prevent flash
  useEffect(() => {
    if (
      !taxInitialized.current &&
      order?.tax_total != null &&
      order.tax_total > 0
    ) {
      setTaxAmount(order.tax_total);
      taxInitialized.current = true;
    }
  }, [order?.tax_total]);

  // Increment to trigger InlineTaxes re-fetch after confirmed item mutations
  const [taxTrigger, setTaxTrigger] = useState(0);
  const bumpTax = useCallback(() => setTaxTrigger((n) => n + 1), []);

  // ── Item wrappers (bump tax after each mutation) ───────────────────────────
  const handleAddItemWithTax = useCallback(
    async (variantId: string, overridePrice?: number) => {
      await handleAddItem(variantId, overridePrice);
      bumpTax();
    },
    [handleAddItem, bumpTax]
  );
  const handleUpdateItemWithTax = useCallback(
    async (itemId: string) => {
      await handleUpdateItem(itemId);
      bumpTax();
    },
    [handleUpdateItem, bumpTax]
  );
  const handleRemoveItemWithTax = useCallback(
    async (itemId: string) => {
      await handleRemoveItem(itemId);
      bumpTax();
    },
    [handleRemoveItem, bumpTax]
  );

  // ── No-shipping modal + convert intercept ─────────────────────────────────
  const [showNoShippingModal, setShowNoShippingModal] = useState(false);
  const shippingRef = useRef<InlineShippingHandle>(null);
  const shippingSectionRef = useRef<HTMLDivElement>(null);

  const handleScrollToShipping = useCallback(() => {
    setShowNoShippingModal(false);
    shippingSectionRef.current?.scrollIntoView({
      behavior: "smooth",
      block: "start",
    });
    setTimeout(() => shippingRef.current?.openPicker(), 500);
  }, []);

  const handleAutoLocalPickup = useCallback(async () => {
    setShowNoShippingModal(false);
    const found = await shippingRef.current?.applyLocalPickup();
    if (!found) {
      handleScrollToShipping();
      return;
    }
    setTimeout(() => handleConvert(), 400);
  }, [handleConvert, handleScrollToShipping]);

  const handleConvertClick = useCallback(async () => {
    const methods: any[] = order?.shipping_methods ?? [];
    const hasShipping = methods.length > 0;
    if (!hasShipping) {
      setShowNoShippingModal(true);
      return;
    }

    // If the ONLY method is a local pickup → patch shipping address to Miami Store
    const PICKUP_KEYWORDS = [
      "pickup",
      "store pickup",
      "local pickup",
      "in store",
      "in-store",
      "miami",
    ];
    const isPickupMethod = (m: any) =>
      PICKUP_KEYWORDS.some((k) => (m.name ?? "").toLowerCase().includes(k));
    if (methods.length === 1 && isPickupMethod(methods[0])) {
      const miamiAddr = {
        first_name: "Miami",
        last_name: "Store",
        company: "Ecopowertech Inc",
        address_1: "2760 W 84th St",
        address_2: "Unit 4",
        city: "Hialeah",
        province: "FL",
        postal_code: "33016",
        country_code: "us",
        phone: "",
      };
      try {
        await fetch(`/admin/draft-orders/${id}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ shipping_address: miamiAddr }),
        });
      } catch (e) {
        console.warn("[handleConvertClick] address patch failed:", e);
      }
    }

    handleConvert();
  }, [id, order?.shipping_methods, handleConvert]);

  // ── Estimate info state ───────────────────────────────────────────────────
  const [showEstimateModal, setShowEstimateModal] = useState(false);
  const [currentEstimateInfo, setCurrentEstimateInfo] =
    useState<EstimateInfo | null>(null);

  const handleSendEstimate = useCallback(() => {
    const info = currentEstimateInfo;
    if (!info) {
      setShowEstimateModal(true);
      return;
    }
    const missing = getMissingEstimateFields(info);
    if (missing.length > 0) {
      import("@medusajs/ui").then(({ toast }) =>
        toast.error(`Please fill in: ${missing.join(", ")}`, {
          description: "These fields are required before sending an estimate.",
        })
      );
      return;
    }
    setShowEstimateModal(true);
  }, [currentEstimateInfo]);

  const handlePrintEstimate = useCallback(() => {
    const missing = currentEstimateInfo
      ? getMissingEstimateFields(currentEstimateInfo)
      : [];
    if (missing.length > 0) {
      import("@medusajs/ui").then(({ toast }) =>
        toast.error(`Please fill in: ${missing.join(", ")}`, {
          description: "These fields are required before printing an estimate.",
        })
      );
      return;
    }
    const iframe = document.createElement("iframe");
    iframe.style.cssText =
      "position:fixed;top:-9999px;left:-9999px;width:1px;height:1px;border:0;";
    document.body.appendChild(iframe);
    iframe.onload = () => {
      setTimeout(() => {
        try {
          document.body.removeChild(iframe);
        } catch {}
      }, 120_000);
    };
    iframe.src = `/admin/draft-orders/${id ?? ""}/send-estimate?mode=print`;
  }, [id, currentEstimateInfo]);

  const handleEstimateSuccess = useCallback(
    (sentTo: string) => {
      addTimelineEvent(
        "Email Sent",
        `Estimate emailed to ${sentTo}`,
        currentUser || undefined
      );
      // Same "last event wins" policy as the backend send-email route: a
      // re-send only refuses to move a status the doc considers terminal.
      if (estimateStatus !== "Voided") handleStatusChange("Sent by Email");
    },
    [addTimelineEvent, currentUser, estimateStatus, handleStatusChange]
  );

  // ── Computed totals (live from UI state) ──────────────────────────────────
  const computedSubtotal = (order?.items ?? []).reduce(
    (sum: number, item: any) => {
      const price =
        itemPrices[item.id!] !== undefined
          ? parseFloat(itemPrices[item.id!]!)
          : (item.unit_price ?? 0);
      const qty = itemQtys[item.id!] ?? item.quantity ?? 1;
      return sum + price * qty;
    },
    0
  );
  const shippingDollars = order?.shipping_total ?? 0;
  const discountDollars = order?.discount_total ?? 0;
  const computedTotal =
    computedSubtotal + shippingDollars - discountDollars + taxAmount;

  // Computed total for estimate email modal
  const estimateTotal = computedTotal;

  return {
    // Tax
    taxAmount,
    setTaxAmount,
    taxRate,
    setTaxRate,
    taxTrigger,
    bumpTax,
    // Item tax wrappers
    handleAddItemWithTax,
    handleUpdateItemWithTax,
    handleRemoveItemWithTax,
    // Convert + no-shipping modal
    showNoShippingModal,
    setShowNoShippingModal,
    shippingRef,
    shippingSectionRef,
    handleConvertClick,
    handleScrollToShipping,
    handleAutoLocalPickup,
    // Estimate
    showEstimateModal,
    setShowEstimateModal,
    currentEstimateInfo,
    setCurrentEstimateInfo,
    handleSendEstimate,
    handlePrintEstimate,
    handleEstimateSuccess,
    estimateTotal,
    // Computed totals
    computedSubtotal,
    shippingDollars,
    discountDollars,
    computedTotal,
  };
};

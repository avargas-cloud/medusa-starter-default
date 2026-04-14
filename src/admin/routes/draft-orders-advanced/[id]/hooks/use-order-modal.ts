import { useState, useRef } from "react";
import { toast } from "@medusajs/ui";
import { ModalType, AddrForm, DraftOrderDetail, emptyAddr } from "../types";

interface Deps {
  id: string | undefined;
  order: DraftOrderDetail | null;
  setItemQtys: (q: Record<string, number>) => void;
  setItemPrices: (p: Record<string, string>) => void;
  metadataForm: Record<string, string>;
  setMetadataForm: (m: Record<string, string>) => void;
  setMetaNewKey: (k: string) => void;
  setMetaNewVal: (v: string) => void;
  fetchOrder: () => Promise<void>;
}

/** Owns modal open/close, all modal form state, customer search, and modal save handlers. */
export const useOrderModal = ({
  id,
  order,
  setItemQtys,
  setItemPrices,
  metadataForm,
  setMetadataForm,
  setMetaNewKey,
  setMetaNewVal,
  fetchOrder,
}: Deps) => {
  const [modal, setModal] = useState<ModalType>(null);
  const [saving, setSaving] = useState(false);
  const [salesChannels, setSalesChannels] = useState<
    { id: string; name: string }[]
  >([]);
  const [selectedSc, setSelectedSc] = useState("");
  const [emailForm, setEmailForm] = useState("");
  const [shippingAddrForm, setShippingAddrForm] =
    useState<AddrForm>(emptyAddr());
  const [billingAddrForm, setBillingAddrForm] = useState<AddrForm>(emptyAddr());
  const [customerQuery, setCustomerQuery] = useState("");
  const [customers, setCustomers] = useState<
    {
      id: string;
      first_name?: string;
      last_name?: string;
      email?: string;
      company_name?: string;
    }[]
  >([]);
  const [selectedCustomer, setSelectedCustomer] = useState("");
  const [shippingOptions, setShippingOptions] = useState<
    { id: string; name: string; amount: number }[]
  >([]);
  const [selectedOption, setSelectedOption] = useState("");
  const [customAmount, setCustomAmount] = useState("");
  const [itemActionMap, setItemActionMap] = useState<Record<string, string>>(
    {}
  );
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const patchOrder = async (body: Record<string, any>) => {
    const r = await fetch(`/admin/draft-orders/${id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(j.message || `HTTP ${r.status}`);
    }
    return r.json();
  };

  const openModal = async (type: ModalType) => {
    setModal(type);
    if (type === "sales-channel") {
      setSelectedSc(order?.sales_channel?.id ?? "");
      const r = await fetch("/admin/sales-channels?limit=100", {
        credentials: "include",
      });
      if (r.ok) {
        const j = await r.json();
        setSalesChannels(j.sales_channels ?? []);
      }
    }
    if (type === "email") setEmailForm(order?.email ?? "");
    if (type === "shipping-addr")
      setShippingAddrForm({
        first_name: order?.shipping_address?.first_name ?? "",
        last_name: order?.shipping_address?.last_name ?? "",
        company: order?.customer?.company_name ?? "",
        address_1: order?.shipping_address?.address_1 ?? "",
        address_2: order?.shipping_address?.address_2 ?? "",
        city: order?.shipping_address?.city ?? "",
        province: order?.shipping_address?.province ?? "",
        postal_code: order?.shipping_address?.postal_code ?? "",
        country_code: order?.shipping_address?.country_code ?? "US",
        phone: order?.shipping_address?.phone ?? "",
      });
    if (type === "billing-addr")
      setBillingAddrForm({
        first_name: order?.billing_address?.first_name ?? "",
        last_name: order?.billing_address?.last_name ?? "",
        company: (order?.billing_address as any)?.company ?? "",
        address_1: order?.billing_address?.address_1 ?? "",
        address_2: order?.billing_address?.address_2 ?? "",
        city: order?.billing_address?.city ?? "",
        province: order?.billing_address?.province ?? "",
        postal_code: order?.billing_address?.postal_code ?? "",
        country_code: order?.billing_address?.country_code ?? "US",
        phone: order?.billing_address?.phone ?? "",
      });
    if (type === "transfer") {
      setCustomerQuery("");
      setCustomers([]);
      setSelectedCustomer("");
    }
    if (type === "add-shipping") {
      setShippingOptions([]);
      setSelectedOption("");
      setCustomAmount("");
      const r = await fetch(`/admin/shipping-options`, {
        credentials: "include",
      });
      if (r.ok) {
        const j = await r.json();
        setShippingOptions(j.shipping_options ?? []);
      }
    }
    if (type === "metadata") {
      const meta = order?.metadata ?? {};
      const cleaned: Record<string, string> = {};
      Object.entries(meta).forEach(([k, v]) => {
        if (k !== "order_status" && k !== "estimate_status")
          cleaned[k] = String(v ?? "");
      });
      setMetadataForm(cleaned);
      setMetaNewKey("");
      setMetaNewVal("");
    }
    if (type === "edit-items") {
      const qtys: Record<string, number> = {};
      const prices: Record<string, string> = {};
      order?.items.forEach((item) => {
        qtys[item.id] = item.quantity;
        prices[item.id] = String(item.unit_price ?? 0);
      });
      setItemQtys(qtys);
      setItemPrices(prices);
      const ar = await fetch(`/admin/orders/${id}/changes`, {
        credentials: "include",
      });
      if (ar.ok) {
        const aj = await ar.json();
        const map: Record<string, string> = {};
        (aj.order_changes ?? []).forEach((c: any) =>
          (c.actions ?? []).forEach((a: any) => {
            if (a.action === "ITEM_ADD" && a.details?.reference_id && a.id)
              map[a.details.reference_id] = a.id;
          })
        );
        setItemActionMap(map);
      }
    }
  };

  // ── Customer search ──────────────────────────────────────────────────────
  const searchCustomers = (q: string) => {
    setCustomerQuery(q);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(async () => {
      if (!q.trim()) {
        setCustomers([]);
        return;
      }
      try {
        const tokens = q.trim().split(/\s+/);
        const params = new Set<string>();
        params.add(`q=${encodeURIComponent(q)}&limit=10`);
        if (tokens.length >= 2) {
          params.add(
            `first_name=${encodeURIComponent(tokens[0]!)}&last_name=${encodeURIComponent(tokens.slice(1).join(" "))}&limit=10`
          );
          params.add(
            `first_name=${encodeURIComponent(tokens.slice(0, -1).join(" "))}&last_name=${encodeURIComponent(tokens[tokens.length - 1]!)}&limit=10`
          );
        }
        for (const tok of tokens) {
          params.add(`first_name=${encodeURIComponent(tok)}&limit=10`);
          params.add(`last_name=${encodeURIComponent(tok)}&limit=10`);
          params.add(`email=${encodeURIComponent(tok)}&limit=10`);
          params.add(`phone=${encodeURIComponent(tok)}&limit=10`);
        }
        const responses = await Promise.allSettled(
          [...params].map((p) =>
            fetch(`/admin/customers?${p}`, { credentials: "include" })
          )
        );
        const seen = new Set<string>();
        const merged: typeof customers = [];
        for (const res of responses) {
          if (res.status !== "fulfilled" || !res.value.ok) continue;
          const j = await res.value.json();
          for (const c of j.customers ?? []) {
            if (!seen.has(c.id)) {
              seen.add(c.id);
              merged.push(c);
            }
          }
        }
        setCustomers(merged.slice(0, 15));
      } catch {
        setCustomers([]);
      }
    }, 350);
  };

  // ── Save handlers ────────────────────────────────────────────────────────
  const handleSaveSalesChannel = async () => {
    setSaving(true);
    try {
      await patchOrder({ sales_channel_id: selectedSc });
      toast.success("Sales channel updated");
      setModal(null);
      fetchOrder();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setSaving(false);
    }
  };
  const handleSaveEmail = async () => {
    setSaving(true);
    try {
      await patchOrder({ email: emailForm });
      toast.success("Email updated");
      setModal(null);
      fetchOrder();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setSaving(false);
    }
  };
  const handleSaveShippingAddr = async () => {
    setSaving(true);
    try {
      await patchOrder({ shipping_address: shippingAddrForm });
      toast.success("Shipping address updated");
      setModal(null);
      fetchOrder();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setSaving(false);
    }
  };
  const handleSaveBillingAddr = async () => {
    setSaving(true);
    try {
      await patchOrder({ billing_address: billingAddrForm });
      toast.success("Billing address updated");
      setModal(null);
      fetchOrder();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setSaving(false);
    }
  };
  const handleTransfer = async (): Promise<void> => {
    if (!selectedCustomer) {
      toast.error("Select a customer first");
      return;
    }
    setSaving(true);
    try {
      await patchOrder({ customer_id: selectedCustomer });
      toast.success("Ownership transferred");
      setModal(null);
      fetchOrder();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setSaving(false);
    }
  };
  const handleSaveMetadata = async (): Promise<void> => {
    setSaving(true);
    try {
      const existing = order?.metadata ?? {};
      const updated = { ...existing, ...metadataForm };
      Object.keys(existing).forEach((k) => {
        if (
          k !== "order_status" &&
          k !== "estimate_status" &&
          !(k in metadataForm)
        )
          updated[k] = null;
      });
      await patchOrder({ metadata: updated });
      toast.success("Metadata updated");
      setModal(null);
      fetchOrder();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setSaving(false);
    }
  };

  return {
    modal,
    setModal,
    saving,
    itemActionMap,
    salesChannels,
    selectedSc,
    setSelectedSc,
    emailForm,
    setEmailForm,
    shippingAddrForm,
    setShippingAddrForm,
    billingAddrForm,
    setBillingAddrForm,
    customerQuery,
    customers,
    selectedCustomer,
    setSelectedCustomer,
    shippingOptions,
    selectedOption,
    setSelectedOption,
    customAmount,
    setCustomAmount,
    openModal,
    closeModal: () => setModal(null),
    searchCustomers,
    handleSaveSalesChannel,
    handleSaveEmail,
    handleSaveShippingAddr,
    handleSaveBillingAddr,
    handleTransfer,
    handleSaveMetadata,
    patchOrder,
  };
};

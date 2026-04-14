import { useState, useEffect, useRef } from "react";
import { Heading, Text, Button, Badge } from "@medusajs/ui";
import { toast } from "@medusajs/ui";

interface Address {
  id: string;
  first_name?: string;
  last_name?: string;
  company?: string;
  address_1?: string;
  address_2?: string;
  city?: string;
  country_code?: string;
  province?: string;
  postal_code?: string;
  phone?: string;
  is_default_shipping?: boolean;
  is_default_billing?: boolean;
}

interface Customer {
  id: string;
  first_name?: string;
  last_name?: string;
  email?: string;
  company_name?: string;
  phone?: string;
}

interface CreateDraftOrderModalProps {
  onClose: () => void;
  onCreated: (id: string) => void;
}

export const CreateDraftOrderModal = ({
  onClose,
  onCreated,
}: CreateDraftOrderModalProps) => {
  const [regions, setRegions] = useState<
    { id: string; name: string; currency_code: string }[]
  >([]);
  const [salesChannels, setSalesChannels] = useState<
    { id: string; name: string }[]
  >([]);
  const [selectedRegion, setSelectedRegion] = useState("");
  const [selectedSc, setSelectedSc] = useState("");
  const [customerQuery, setCustomerQuery] = useState("");
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [selectedCustomer, setSelectedCustomer] = useState<{
    id: string;
    label: string;
    email: string;
  } | null>(null);
  const [showCustomerDrop, setShowCustomerDrop] = useState(false);
  const [shippingAddress, setShippingAddress] = useState<Address | null>(null);
  const [billingAddress, setBillingAddress] = useState<Address | null>(null);
  const [saving, setSaving] = useState(false);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const custRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    Promise.all([
      fetch("/admin/regions?limit=100", { credentials: "include" }).then((r) =>
        r.json()
      ),
      fetch("/admin/sales-channels?limit=100", { credentials: "include" }).then(
        (r) => r.json()
      ),
    ])
      .then(([rj, scj]) => {
        const regs = rj.regions ?? [];
        setRegions(regs);
        if (regs.length > 0) setSelectedRegion(regs[0].id);
        const scs = scj.sales_channels ?? [];
        setSalesChannels(scs);
        if (scs.length > 0) setSelectedSc(scs[0].id);
      })
      .catch(() => {});
  }, []);

  const fetchByTerm = async (term: string): Promise<Customer[]> => {
    const r = await fetch(
      `/admin/customers?q=${encodeURIComponent(term)}&limit=20&fields=id,first_name,last_name,email,company_name,phone`,
      { credentials: "include" }
    );
    if (!r.ok) return [];
    const j = await r.json();
    return j.customers ?? [];
  };

  const searchCustomers = (q: string) => {
    setCustomerQuery(q);
    setSelectedCustomer(null);
    setShippingAddress(null);
    setBillingAddress(null);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(async () => {
      const trimmed = q.trim();
      if (!trimmed) {
        setCustomers([]);
        setShowCustomerDrop(false);
        return;
      }

      // Split query into individual words
      const parts = trimmed.split(/\s+/).filter(Boolean);

      // When multi-word (e.g. "alejandro v"), search full query + each word in parallel
      // so the API can match across first_name and last_name independently
      const searches =
        parts.length > 1
          ? [fetchByTerm(trimmed), ...parts.map((p) => fetchByTerm(p))]
          : [fetchByTerm(trimmed)];

      const results = await Promise.all(searches);

      // Merge and deduplicate by id
      const seen = new Set<string>();
      const merged: Customer[] = [];
      for (const list of results) {
        for (const c of list) {
          if (!seen.has(c.id)) {
            seen.add(c.id);
            merged.push(c);
          }
        }
      }

      // Client-side filter: every search word must appear somewhere in the customer data
      const lowerParts = parts.map((p) => p.toLowerCase());
      const filtered = merged.filter((c) => {
        const haystack = [
          c.first_name,
          c.last_name,
          c.email,
          c.company_name,
          c.phone,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        return lowerParts.every((p) => haystack.includes(p));
      });

      setCustomers(filtered.slice(0, 10));
      setShowCustomerDrop(true);
    }, 300);
  };

  const fetchCustomerAddresses = async (customerId: string) => {
    try {
      const r = await fetch(
        `/admin/customers/${customerId}?fields=*addresses`,
        { credentials: "include" }
      );
      if (!r.ok) return;
      const j = await r.json();
      const addresses: Address[] = j.customer?.addresses ?? [];

      const shipping =
        addresses.find((a) => a.is_default_shipping) ?? addresses[0] ?? null;
      const billing = addresses.find((a) => a.is_default_billing) ?? shipping;

      setShippingAddress(shipping);
      setBillingAddress(billing ?? null);
    } catch {
      // No addresses — that's fine
    }
  };

  const pickCustomer = async (c: Customer) => {
    const fullName = [c.first_name, c.last_name].filter(Boolean).join(" ");
    const displayLabel =
      [fullName || null, c.company_name ? `(${c.company_name})` : null]
        .filter(Boolean)
        .join(" ") ||
      c.email ||
      c.id;

    setSelectedCustomer({
      id: c.id,
      label: displayLabel,
      email: c.email ?? "",
    });
    setCustomerQuery(fullName || c.email || "");
    setCustomers([]);
    setShowCustomerDrop(false);

    await fetchCustomerAddresses(c.id);
  };

  const formatAddress = (addr: Address | null): string => {
    if (!addr) return "";
    const parts = [
      addr.address_1,
      addr.city,
      addr.country_code?.toUpperCase(),
    ].filter(Boolean);
    return parts.join(", ");
  };

  const handleCreate = async () => {
    if (!selectedRegion) {
      toast.error("Select a region");
      return;
    }
    if (!selectedCustomer) {
      toast.error("Please select a customer");
      return;
    }

    setSaving(true);
    try {
      const body: Record<string, any> = {
        region_id: selectedRegion,
        customer_id: selectedCustomer.id,
        email: selectedCustomer.email,
      };

      if (selectedSc) body.sales_channel_id = selectedSc;

      if (shippingAddress) {
        body.shipping_address = {
          first_name: shippingAddress.first_name,
          last_name: shippingAddress.last_name,
          company: shippingAddress.company,
          address_1: shippingAddress.address_1,
          address_2: shippingAddress.address_2,
          city: shippingAddress.city,
          country_code: shippingAddress.country_code,
          province: shippingAddress.province,
          postal_code: shippingAddress.postal_code,
          phone: shippingAddress.phone,
        };
      }

      if (billingAddress) {
        body.billing_address = {
          first_name: billingAddress.first_name,
          last_name: billingAddress.last_name,
          company: billingAddress.company,
          address_1: billingAddress.address_1,
          address_2: billingAddress.address_2,
          city: billingAddress.city,
          country_code: billingAddress.country_code,
          province: billingAddress.province,
          postal_code: billingAddress.postal_code,
          phone: billingAddress.phone,
        };
      }

      const r = await fetch("/admin/draft-orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(body),
      });

      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.message || `HTTP ${r.status}`);
      }

      const j = await r.json();
      const newId = j.draft_order?.id ?? j.order?.id;
      if (newId) {
        toast.success("Draft order created");
        onCreated(newId);
      } else throw new Error("No ID returned");
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      onClick={onClose}
    >
      <div className="absolute inset-0 bg-black/40" />
      <div
        className="relative bg-ui-bg-base border border-ui-border-base rounded-xl shadow-2xl w-full max-w-md mx-4 p-6 z-10"
        onClick={(e) => e.stopPropagation()}
      >
        <Heading level="h2" className="mb-5">
          New Draft Order
        </Heading>

        {/* Region */}
        <div className="mb-4">
          <Text size="small" weight="plus" className="mb-1 block">
            Region *
          </Text>
          <select
            value={selectedRegion}
            onChange={(e) => setSelectedRegion(e.target.value)}
            className="w-full border border-ui-border-base rounded-md px-3 py-2 text-sm bg-ui-bg-base text-ui-fg-base focus:outline-none focus:ring-1 focus:ring-ui-border-interactive"
          >
            {regions.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name} ({r.currency_code?.toUpperCase()})
              </option>
            ))}
          </select>
        </div>

        {/* Sales Channel */}
        {salesChannels.length > 0 && (
          <div className="mb-4">
            <Text size="small" weight="plus" className="mb-1 block">
              Sales Channel
            </Text>
            <select
              value={selectedSc}
              onChange={(e) => setSelectedSc(e.target.value)}
              className="w-full border border-ui-border-base rounded-md px-3 py-2 text-sm bg-ui-bg-base text-ui-fg-base focus:outline-none focus:ring-1 focus:ring-ui-border-interactive"
            >
              {salesChannels.map((sc) => (
                <option key={sc.id} value={sc.id}>
                  {sc.name}
                </option>
              ))}
            </select>
          </div>
        )}

        {/* Customer Search */}
        <div className="mb-6 relative" ref={custRef}>
          <Text size="small" weight="plus" className="mb-1 block">
            Customer *
          </Text>
          <input
            type="text"
            value={customerQuery}
            onChange={(e) => searchCustomers(e.target.value)}
            placeholder="Search by name, company, email or phone..."
            className="w-full border border-ui-border-base rounded-md px-3 py-2 text-sm bg-ui-bg-base text-ui-fg-base placeholder:text-ui-fg-muted focus:outline-none focus:ring-1 focus:ring-ui-border-interactive"
          />

          {selectedCustomer && (
            <div className="mt-2 space-y-1">
              <Badge size="small" color="blue">
                {selectedCustomer.label} · {selectedCustomer.email}
              </Badge>
              {shippingAddress && (
                <p className="text-xs text-ui-fg-muted">
                  📦 Shipping: {formatAddress(shippingAddress)}
                </p>
              )}
              {billingAddress && (
                <p className="text-xs text-ui-fg-muted">
                  🧾 Billing: {formatAddress(billingAddress)}
                </p>
              )}
              {!shippingAddress && (
                <p className="text-xs text-ui-fg-muted italic">
                  No saved addresses — will be set in order detail
                </p>
              )}
            </div>
          )}

          {showCustomerDrop && customers.length > 0 && (
            <div className="absolute top-full left-0 right-0 mt-1 bg-ui-bg-base border border-ui-border-base rounded-md shadow-lg z-20 max-h-48 overflow-y-auto">
              {customers.map((c) => {
                const fullName = [c.first_name, c.last_name]
                  .filter(Boolean)
                  .join(" ");
                const line2Parts = [c.email, c.phone].filter(Boolean);
                return (
                  <button
                    key={c.id}
                    className="w-full text-left px-3 py-2.5 hover:bg-ui-bg-subtle border-b border-ui-border-base last:border-0"
                    onClick={() => pickCustomer(c)}
                  >
                    <div className="flex items-baseline gap-1.5">
                      <span className="text-sm font-medium text-ui-fg-base">
                        {fullName || c.email}
                      </span>
                      {c.company_name && (
                        <span className="text-xs text-ui-fg-subtle">
                          · {c.company_name}
                        </span>
                      )}
                    </div>
                    {line2Parts.length > 0 && (
                      <span className="block text-xs text-ui-fg-muted mt-0.5">
                        {line2Parts.join(" · ")}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="flex items-center gap-3 justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-ui-fg-subtle hover:text-ui-fg-base transition-colors"
          >
            Cancel
          </button>
          <Button
            size="small"
            disabled={saving || !selectedRegion || !selectedCustomer}
            onClick={handleCreate}
          >
            {saving ? "Creating…" : "Create Draft Order"}
          </Button>
        </div>
      </div>
    </div>
  );
};

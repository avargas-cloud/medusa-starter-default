import { useState, useEffect } from "react"
import { Input, Label, Text } from "@medusajs/ui"
import type { AddrForm } from "../types"

interface SavedAddress {
    id: string
    first_name?: string
    last_name?: string
    company?: string
    address_1?: string
    address_2?: string
    city?: string
    province?: string
    postal_code?: string
    country_code?: string
    phone?: string
    is_default_shipping?: boolean
    is_default_billing?: boolean
}

interface AddrFormFieldsProps {
    form: AddrForm
    onChange: (k: keyof AddrForm, v: string) => void
    /** Customer ID — if provided, loads saved addresses for quick-fill dropdown */
    customerId?: string
}

export const AddrFormFields = ({ form, onChange, customerId }: AddrFormFieldsProps) => {
    const [savedAddresses, setSavedAddresses] = useState<SavedAddress[]>([])

    useEffect(() => {
        if (!customerId) return
        fetch(`/admin/customers/${customerId}?fields=*addresses`, { credentials: "include" })
            .then(r => r.ok ? r.json() : null)
            .then(j => {
                const addrs: SavedAddress[] = j?.customer?.addresses ?? []
                setSavedAddresses(addrs)
            })
            .catch(() => { })
    }, [customerId])

    const applyAddress = (addr: SavedAddress) => {
        const fields: (keyof AddrForm)[] = [
            "first_name", "last_name", "company", "address_1", "address_2",
            "city", "province", "postal_code", "country_code", "phone"
        ]
        fields.forEach(k => onChange(k, (addr as any)[k] ?? ""))
    }

    const formatAddrLabel = (addr: SavedAddress): string => {
        const name = [addr.first_name, addr.last_name].filter(Boolean).join(" ")
        const line = [addr.address_1, addr.city, addr.province, addr.country_code?.toUpperCase()].filter(Boolean).join(", ")
        const badges: string[] = []
        if (addr.is_default_shipping) badges.push("Default Shipping")
        if (addr.is_default_billing) badges.push("Default Billing")
        return [name, line, badges.join(" · ")].filter(Boolean).join(" — ")
    }

    return (
        <div className="space-y-3">
            {/* ── Saved addresses dropdown ─────────────────────────────── */}
            {savedAddresses.length > 0 && (
                <div>
                    <Label className="mb-1 block text-sm">Saved Addresses</Label>
                    <select
                        defaultValue=""
                        onChange={e => {
                            const addr = savedAddresses.find(a => a.id === e.target.value)
                            if (addr) applyAddress(addr)
                        }}
                        className="w-full border border-ui-border-base rounded-md px-3 py-2 text-sm bg-ui-bg-base text-ui-fg-base focus:outline-none focus:ring-1 focus:ring-ui-border-interactive"
                    >
                        <option value="" disabled>— Select a saved address to auto-fill —</option>
                        {savedAddresses.map(addr => (
                            <option key={addr.id} value={addr.id}>
                                {formatAddrLabel(addr)}
                            </option>
                        ))}
                    </select>
                    <Text size="xsmall" className="text-ui-fg-muted mt-1">
                        Selecting an address fills the fields below. You can still edit them manually.
                    </Text>
                    <div className="border-b border-ui-border-base mt-3" />
                </div>
            )}

            {/* ── Manual fields ────────────────────────────────────────── */}
            {(["first_name", "last_name"] as const).map((k) => (
                <div key={k}>
                    <Label className="mb-1 block text-sm">{k === "first_name" ? "First Name" : "Last Name"}</Label>
                    <Input value={form[k]} onChange={e => onChange(k, e.target.value)} />
                </div>
            ))}
            <div><Label className="mb-1 block text-sm">Company (optional)</Label><Input value={form.company ?? ""} onChange={e => onChange("company", e.target.value)} /></div>
            <div><Label className="mb-1 block text-sm">Address 1</Label><Input value={form.address_1} onChange={e => onChange("address_1", e.target.value)} /></div>
            <div><Label className="mb-1 block text-sm">Address 2 (optional)</Label><Input value={form.address_2} onChange={e => onChange("address_2", e.target.value)} /></div>
            {(["city", "province", "postal_code", "country_code"] as const).map((k) => (
                <div key={k}>
                    <Label className="mb-1 block text-sm">
                        {k === "city" ? "City" : k === "province" ? "State / Province" : k === "postal_code" ? "Postal Code" : "Country Code (e.g. US)"}
                    </Label>
                    <Input value={form[k]} onChange={e => onChange(k, e.target.value)} />
                </div>
            ))}
            <div><Label className="mb-1 block text-sm">Phone (optional)</Label><Input value={form.phone ?? ""} onChange={e => onChange("phone", e.target.value)} /></div>
        </div>
    )
}

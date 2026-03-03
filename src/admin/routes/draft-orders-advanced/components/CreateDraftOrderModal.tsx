import { useState, useEffect, useRef } from "react"
import { Heading, Text, Button, Badge } from "@medusajs/ui"
import { toast } from "@medusajs/ui"

interface CreateDraftOrderModalProps {
    onClose: () => void
    onCreated: (id: string) => void
}

export const CreateDraftOrderModal = ({ onClose, onCreated }: CreateDraftOrderModalProps) => {
    const [regions, setRegions] = useState<{ id: string; name: string; currency_code: string }[]>([])
    const [salesChannels, setSalesChannels] = useState<{ id: string; name: string }[]>([])
    const [selectedRegion, setSelectedRegion] = useState("")
    const [selectedSc, setSelectedSc] = useState("")
    const [customerQuery, setCustomerQuery] = useState("")
    const [customers, setCustomers] = useState<{ id: string; first_name?: string; last_name?: string; email?: string; company_name?: string; phone?: string }[]>([])
    const [selectedCustomer, setSelectedCustomer] = useState<{ id: string; label: string } | null>(null)
    const [showCustomerDrop, setShowCustomerDrop] = useState(false)
    const [email, setEmail] = useState("")
    const [saving, setSaving] = useState(false)
    const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
    const custRef = useRef<HTMLDivElement>(null)

    useEffect(() => {
        Promise.all([
            fetch("/admin/regions?limit=100", { credentials: "include" }).then(r => r.json()),
            fetch("/admin/sales-channels?limit=100", { credentials: "include" }).then(r => r.json()),
        ]).then(([rj, scj]) => {
            const regs = rj.regions ?? []
            setRegions(regs)
            if (regs.length > 0) setSelectedRegion(regs[0].id)
            const scs = scj.sales_channels ?? []
            setSalesChannels(scs)
            if (scs.length > 0) setSelectedSc(scs[0].id)
        }).catch(() => { })
    }, [])

    const searchCustomers = (q: string) => {
        setCustomerQuery(q)
        setSelectedCustomer(null)
        if (searchTimer.current) clearTimeout(searchTimer.current)
        searchTimer.current = setTimeout(async () => {
            if (!q) { setCustomers([]); setShowCustomerDrop(false); return }
            // Request phone + company_name fields explicitly for rich display
            const r = await fetch(
                `/admin/customers?q=${encodeURIComponent(q)}&limit=10&fields=id,first_name,last_name,email,company_name,phone`,
                { credentials: "include" }
            )
            if (r.ok) { const j = await r.json(); setCustomers(j.customers ?? []); setShowCustomerDrop(true) }
        }, 300)
    }

    const pickCustomer = (c: typeof customers[0]) => {
        const fullName = [c.first_name, c.last_name].filter(Boolean).join(" ")
        const displayLabel = [fullName || null, c.company_name ? `(${c.company_name})` : null].filter(Boolean).join(" ") || c.email || c.id
        setSelectedCustomer({ id: c.id, label: displayLabel })
        setEmail(c.email ?? "")
        setCustomerQuery(fullName || c.email || "")
        setCustomers([]); setShowCustomerDrop(false)
    }

    const handleCreate = async () => {
        if (!selectedRegion) { toast.error("Select a region"); return }
        if (!email && !selectedCustomer) { toast.error("Enter customer email or select a customer"); return }
        setSaving(true)
        try {
            const body: Record<string, any> = { region_id: selectedRegion }
            if (selectedSc) body.sales_channel_id = selectedSc
            if (selectedCustomer) { body.customer_id = selectedCustomer.id; body.email = email }
            else if (email) { body.email = email }
            const r = await fetch("/admin/draft-orders", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                credentials: "include",
                body: JSON.stringify(body)
            })
            if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.message || `HTTP ${r.status}`) }
            const j = await r.json()
            const newId = j.draft_order?.id ?? j.order?.id
            if (newId) { toast.success("Draft order created"); onCreated(newId) }
            else throw new Error("No ID returned")
        } catch (e: any) { toast.error(e.message) } finally { setSaving(false) }
    }

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center" onClick={onClose}>
            <div className="absolute inset-0 bg-black/40" />
            <div className="relative bg-ui-bg-base border border-ui-border-base rounded-xl shadow-2xl w-full max-w-md mx-4 p-6 z-10" onClick={e => e.stopPropagation()}>
                <Heading level="h2" className="mb-5">New Draft Order</Heading>

                {/* Region */}
                <div className="mb-4">
                    <Text size="small" weight="plus" className="mb-1 block">Region *</Text>
                    <select
                        value={selectedRegion}
                        onChange={e => setSelectedRegion(e.target.value)}
                        className="w-full border border-ui-border-base rounded-md px-3 py-2 text-sm bg-ui-bg-base text-ui-fg-base focus:outline-none focus:ring-1 focus:ring-ui-border-interactive"
                    >
                        {regions.map(r => <option key={r.id} value={r.id}>{r.name} ({r.currency_code?.toUpperCase()})</option>)}
                    </select>
                </div>

                {/* Sales Channel */}
                {salesChannels.length > 0 && (
                    <div className="mb-4">
                        <Text size="small" weight="plus" className="mb-1 block">Sales Channel</Text>
                        <select
                            value={selectedSc}
                            onChange={e => setSelectedSc(e.target.value)}
                            className="w-full border border-ui-border-base rounded-md px-3 py-2 text-sm bg-ui-bg-base text-ui-fg-base focus:outline-none focus:ring-1 focus:ring-ui-border-interactive"
                        >
                            {salesChannels.map(sc => <option key={sc.id} value={sc.id}>{sc.name}</option>)}
                        </select>
                    </div>
                )}

                {/* Customer Search */}
                <div className="mb-4 relative" ref={custRef}>
                    <Text size="small" weight="plus" className="mb-1 block">Customer</Text>
                    <input
                        type="text"
                        value={customerQuery}
                        onChange={e => searchCustomers(e.target.value)}
                        placeholder="Search by name, company, email or phone..."
                        className="w-full border border-ui-border-base rounded-md px-3 py-2 text-sm bg-ui-bg-base text-ui-fg-base placeholder:text-ui-fg-muted focus:outline-none focus:ring-1 focus:ring-ui-border-interactive"
                    />
                    {selectedCustomer && <Badge size="small" color="blue" className="mt-1">{selectedCustomer.label}</Badge>}
                    {showCustomerDrop && customers.length > 0 && (
                        <div className="absolute top-full left-0 right-0 mt-1 bg-ui-bg-base border border-ui-border-base rounded-md shadow-lg z-20 max-h-48 overflow-y-auto">
                            {customers.map(c => {
                                const fullName = [c.first_name, c.last_name].filter(Boolean).join(" ")
                                const line2Parts = [c.email, c.phone].filter(Boolean)
                                return (
                                    <button key={c.id} className="w-full text-left px-3 py-2.5 hover:bg-ui-bg-subtle border-b border-ui-border-base last:border-0" onClick={() => pickCustomer(c)}>
                                        <div className="flex items-baseline gap-1.5">
                                            <span className="text-sm font-medium text-ui-fg-base">{fullName || c.email}</span>
                                            {c.company_name && <span className="text-xs text-ui-fg-subtle">· {c.company_name}</span>}
                                        </div>
                                        {line2Parts.length > 0 && (
                                            <span className="block text-xs text-ui-fg-muted mt-0.5">{line2Parts.join(" · ")}</span>
                                        )}
                                    </button>
                                )
                            })}
                        </div>
                    )}
                </div>

                {/* Email (editable, prefilled from customer) */}
                <div className="mb-6">
                    <Text size="small" weight="plus" className="mb-1 block">Email {!selectedCustomer && "*"}</Text>
                    <input
                        type="email"
                        value={email}
                        onChange={e => setEmail(e.target.value)}
                        placeholder="customer@example.com"
                        className="w-full border border-ui-border-base rounded-md px-3 py-2 text-sm bg-ui-bg-base text-ui-fg-base placeholder:text-ui-fg-muted focus:outline-none focus:ring-1 focus:ring-ui-border-interactive"
                    />
                </div>

                <div className="flex items-center gap-3 justify-end">
                    <button onClick={onClose} className="px-4 py-2 text-sm text-ui-fg-subtle hover:text-ui-fg-base transition-colors">Cancel</button>
                    <Button size="small" disabled={saving || !selectedRegion} onClick={handleCreate}>
                        {saving ? "Creating…" : "Create Draft Order"}
                    </Button>
                </div>
            </div>
        </div>
    )
}

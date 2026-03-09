import { useState, useEffect, useCallback } from "react"
import { Container, Heading, Select, Text, Input, toast, Badge } from "@medusajs/ui"
import { ExclamationCircle } from "@medusajs/icons"

// ── Types ─────────────────────────────────────────────────────────────────────

export interface EstimateInfo {
    rep: string
    orderType: string
    leadTime: string
    paymentTerms: string
    project: string
}

// Fields that map to customer defaults (key in EstimateInfo → customer metadata key)
const CUSTOMER_DEFAULT_KEYS: Partial<Record<keyof EstimateInfo, string>> = {
    rep: "default_rep",
    orderType: "default_order_type",
    leadTime: "default_lead_time",
    paymentTerms: "default_payment_terms",
}

// Required field keys and their display labels
const REQUIRED_FIELDS: { key: keyof EstimateInfo; label: string }[] = [
    { key: "rep", label: "Rep" },
    { key: "orderType", label: "Order Type" },
    { key: "leadTime", label: "Lead Time" },
    { key: "paymentTerms", label: "Payment Terms" },
]

/** Returns the list of missing required field labels. Empty array = all good. */
export function getMissingEstimateFields(info: EstimateInfo): string[] {
    return REQUIRED_FIELDS.filter(f => !info[f.key]?.trim()).map(f => f.label)
}

interface Props {
    orderId: string
    customerId?: string
    initialInfo: EstimateInfo
    onInfoChange?: (info: EstimateInfo) => void
}

// ── Component ─────────────────────────────────────────────────────────────────

export const EstimateInfoBlock = ({ orderId, customerId, initialInfo, onInfoChange }: Props) => {
    const [info, setInfo] = useState<EstimateInfo>(initialInfo)
    const [reps, setReps] = useState<{ value: string; label: string }[]>([])
    const [paymentTerms, setPaymentTerms] = useState<string[]>([])
    const [leadTimes, setLeadTimes] = useState<string[]>([])
    const [orderTypes, setOrderTypes] = useState<string[]>([])
    const [saving, setSaving] = useState(false)
    // Customer's current defaults (loaded once on mount)
    const [customerDefaults, setCustomerDefaults] = useState<Partial<EstimateInfo>>({})
    // Which fields are currently being saved to customer defaults
    const [savingField, setSavingField] = useState<Partial<Record<keyof EstimateInfo, boolean>>>({})
    // Customer tax exempt status (read-only display)
    const [isTaxExempt, setIsTaxExempt] = useState<boolean | null>(null)

    const missing = getMissingEstimateFields(info)

    // Load options + customer defaults
    useEffect(() => {
        fetch("/admin/system-defaults", { credentials: "include" })
            .then(r => r.json())
            .then(d => {
                const defaults = d.defaults || []

                setPaymentTerms(defaults.filter((x: any) => x.field_name === "Payment Terms").sort((a: any, b: any) => a.sort_order - b.sort_order).map((x: any) => x.value))
                setLeadTimes(defaults.filter((x: any) => x.field_name === "Lead Time").sort((a: any, b: any) => a.sort_order - b.sort_order).map((x: any) => x.value))
                setOrderTypes(defaults.filter((x: any) => x.field_name === "Order Type").sort((a: any, b: any) => a.sort_order - b.sort_order).map((x: any) => x.value))

                const repOptions = defaults
                    .filter((x: any) => x.field_name === "Sales Rep User")
                    .map((x: any) => {
                        try { return JSON.parse(x.value) } catch { return null }
                    })
                    .filter((parsed: any) => parsed?.active && parsed?.is_sales_rep)
                    .map((parsed: any) => ({ value: parsed.initials, label: parsed.name }))

                setReps(repOptions)
            })
            .catch(() => { })

        // Load customer defaults to compare
        if (customerId) {
            fetch(`/admin/customers/${customerId}`, { credentials: "include" })
                .then(r => r.json())
                .then(({ customer }) => {
                    const m = customer?.metadata ?? {}
                    setCustomerDefaults({
                        rep: m.default_rep ?? "",
                        orderType: m.default_order_type ?? "",
                        leadTime: m.default_lead_time ?? "",
                        paymentTerms: m.default_payment_terms ?? "",
                    })
                    setIsTaxExempt(String(m.is_tax_exempt ?? "").toLowerCase() === "yes")
                })
                .catch(() => { })
        }
    }, [customerId])

    useEffect(() => { setInfo(initialInfo) }, [JSON.stringify(initialInfo)])

    // Save draft order metadata
    const persist = useCallback(async (updated: EstimateInfo) => {
        setSaving(true)
        try {
            const r = await fetch(`/admin/draft-orders/${orderId}`, {
                method: "POST",
                credentials: "include",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    metadata: {
                        estimate_rep: updated.rep,
                        estimate_order_type: updated.orderType,
                        estimate_lead_time: updated.leadTime,
                        estimate_payment_terms: updated.paymentTerms,
                        estimate_project: updated.project,
                    },
                }),
            })
            if (!r.ok) throw new Error("Save failed")
        } catch {
            toast.error("Failed to save estimate details")
        } finally { setSaving(false) }
    }, [orderId])

    // Save a single field to customer defaults
    const saveFieldDefault = useCallback(async (fieldKey: keyof EstimateInfo) => {
        if (!customerId) return
        const metaKey = CUSTOMER_DEFAULT_KEYS[fieldKey]
        if (!metaKey) return
        setSavingField(prev => ({ ...prev, [fieldKey]: true }))
        try {
            const r = await fetch(`/admin/customers/${customerId}`, {
                method: "POST",
                credentials: "include",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ metadata: { [metaKey]: info[fieldKey] } }),
            })
            if (!r.ok) throw new Error("Customer update failed")
            // Update local customer defaults cache so button hides
            setCustomerDefaults(prev => ({ ...prev, [fieldKey]: info[fieldKey] }))
            toast.success("Customer default updated")
        } catch {
            toast.error("Failed to update customer default")
        } finally {
            setSavingField(prev => ({ ...prev, [fieldKey]: false }))
        }
    }, [customerId, info])

    const update = (key: keyof EstimateInfo, value: string) => {
        const next = { ...info, [key]: value }
        setInfo(next)
        onInfoChange?.(next)
        persist(next)
    }

    // Whether a field differs from the customer's stored default
    const isDifferentFromDefault = (key: keyof EstimateInfo) =>
        customerId && CUSTOMER_DEFAULT_KEYS[key] && info[key] !== customerDefaults[key]

    // Label row with optional blue "Set as default" button on the right
    const fieldLabelRow = (key: keyof EstimateInfo, label: string) => {
        const isEmpty = REQUIRED_FIELDS.some(f => f.key === key) && !info[key]?.trim()
        const showDefaultBtn = isDifferentFromDefault(key)
        const isSaving = savingField[key]
        return (
            <div className="flex items-center justify-between mb-1">
                <label className="text-[10px] font-bold text-ui-fg-muted uppercase tracking-wider">
                    {label}
                    {isEmpty && <span className="text-red-500 ml-0.5">*</span>}
                </label>
                {showDefaultBtn && (
                    <button
                        onClick={() => saveFieldDefault(key)}
                        disabled={isSaving}
                        className="text-[10px] text-blue-500 hover:text-blue-400 font-medium leading-none disabled:opacity-50 transition-colors"
                        style={{ background: "none", border: "none", cursor: "pointer", padding: 0 }}
                    >
                        {isSaving ? "Saving…" : "↑ Set as customer default"}
                    </button>
                )}
            </div>
        )
    }

    const triggerClass = (key: keyof EstimateInfo) => {
        const isEmpty = REQUIRED_FIELDS.some(f => f.key === key) && !info[key]?.trim()
        return `h-8 text-sm w-full${isEmpty ? " border-red-400 ring-1 ring-red-300" : ""}`
    }

    return (
        <Container className="p-0 overflow-hidden">
            <div className="flex items-center justify-between px-6 py-4 border-b border-ui-border-base">
                <div className="flex items-center gap-2">
                    <Heading level="h2">Estimate Details</Heading>
                    {missing.length > 0 && (
                        <Badge color="red" size="small" className="flex items-center gap-1">
                            <ExclamationCircle className="w-3 h-3" />
                            {missing.length} required {missing.length === 1 ? "field" : "fields"} missing
                        </Badge>
                    )}
                </div>
                {saving && <Text size="xsmall" className="text-ui-fg-muted">Saving…</Text>}
            </div>

            {missing.length > 0 && (
                <div className="px-6 pt-3 pb-0">
                    <Text size="xsmall" className="text-red-500">Required: {missing.join(", ")}</Text>
                </div>
            )}

            <div className="px-6 py-4 grid grid-cols-2 gap-x-6 gap-y-4">

                {/* Rep */}
                <div>
                    {fieldLabelRow("rep", "Rep")}
                    {reps.length > 0 ? (
                        <Select value={info.rep} onValueChange={v => update("rep", v)}>
                            <Select.Trigger className={triggerClass("rep")}><Select.Value placeholder="Select rep…" /></Select.Trigger>
                            <Select.Content>
                                {reps.map(r => <Select.Item key={r.value} value={r.value}>{r.label}</Select.Item>)}
                            </Select.Content>
                        </Select>
                    ) : (
                        <Input value={info.rep} onChange={e => update("rep", e.target.value)} placeholder="Rep initials…" className={triggerClass("rep")} />
                    )}
                </div>

                {/* Order Type */}
                <div>
                    {fieldLabelRow("orderType", "Order Type")}
                    <Select value={info.orderType} onValueChange={v => update("orderType", v)}>
                        <Select.Trigger className={triggerClass("orderType")}><Select.Value placeholder="Select type…" /></Select.Trigger>
                        <Select.Content>
                            {orderTypes.map(t => <Select.Item key={t} value={t}>{t}</Select.Item>)}
                        </Select.Content>
                    </Select>
                </div>

                {/* Lead Time */}
                <div>
                    {fieldLabelRow("leadTime", "Lead Time")}
                    <Select value={info.leadTime} onValueChange={v => update("leadTime", v)}>
                        <Select.Trigger className={triggerClass("leadTime")}><Select.Value placeholder="Select lead time…" /></Select.Trigger>
                        <Select.Content>
                            {leadTimes.map(t => <Select.Item key={t} value={t}>{t}</Select.Item>)}
                        </Select.Content>
                    </Select>
                </div>

                {/* Payment Terms */}
                <div>
                    {fieldLabelRow("paymentTerms", "Payment Terms")}
                    <Select value={info.paymentTerms} onValueChange={v => update("paymentTerms", v)}>
                        <Select.Trigger className={triggerClass("paymentTerms")}><Select.Value placeholder="Select terms…" /></Select.Trigger>
                        <Select.Content>
                            {paymentTerms.map(t => <Select.Item key={t} value={t}>{t}</Select.Item>)}
                        </Select.Content>
                    </Select>
                </div>

                {/* Project — half width */}
                <div>
                    <label className="text-[10px] font-bold text-ui-fg-muted uppercase tracking-wider mb-1 block">
                        Project Name <span className="text-ui-fg-muted font-normal">(optional)</span>
                    </label>
                    <Input
                        value={info.project}
                        onChange={e => update("project", e.target.value)}
                        placeholder="e.g. Miami Office LED Retrofit"
                        className="h-8 text-sm"
                    />
                </div>

                {/* Tax Status — read-only badge, half width */}
                <div>
                    <label className="text-[10px] font-bold text-ui-fg-muted uppercase tracking-wider mb-1 block">
                        Tax Status
                    </label>
                    <div className="h-8 flex items-center">
                        {isTaxExempt === null ? (
                            <Text size="small" className="text-ui-fg-muted">—</Text>
                        ) : isTaxExempt ? (
                            <Badge color="green" size="small">Tax Exempt</Badge>
                        ) : (
                            <Badge color="blue" size="small">Taxable</Badge>
                        )}
                    </div>
                </div>

            </div>
        </Container>
    )
}

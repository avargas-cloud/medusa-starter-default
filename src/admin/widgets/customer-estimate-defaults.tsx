import { useState, useEffect } from "react"
import { Container, Select, Input, Text, toast } from "@medusajs/ui"
import { defineWidgetConfig } from "@medusajs/admin-sdk"
import { DetailWidgetProps } from "@medusajs/framework/types"
import { HttpTypes } from "@medusajs/types"

// ── Widget config ─────────────────────────────────────────────────────────────

export const config = defineWidgetConfig({
    zone: "customer.details.after",
})

// ── Types ─────────────────────────────────────────────────────────────────────

interface EstimateDefaults {
    default_rep: string
    default_order_type: string
    default_lead_time: string
    default_payment_terms: string
}


// ── Widget component ──────────────────────────────────────────────────────────

const CustomerEstimateWidget = ({ data }: DetailWidgetProps<HttpTypes.AdminCustomer>) => {
    const [reps, setReps] = useState<{ value: string; label: string }[]>([])
    const [options, setOptions] = useState<{
        payment_terms: string[]
        lead_times: string[]
        order_types: string[]
    }>({ payment_terms: [], lead_times: [], order_types: [] })
    const [defaults, setDefaults] = useState<EstimateDefaults>({
        default_rep: "",
        default_order_type: "",
        default_lead_time: "",
        default_payment_terms: "",
    })
    const [saving, setSaving] = useState(false)

    useEffect(() => {
        // Load options
        fetch("/admin/estimate-options", { credentials: "include" })
            .then(r => r.json())
            .then(d => {
                setOptions(d)
                if (d.sales_reps) {
                    setReps(d.sales_reps.map((u: any) => ({
                        value: u.initials,
                        label: `${u.initials} - ${u.name}`
                    })))
                }
            })
            .catch(() => { })

        // Seed from existing customer metadata
        const m: any = (data as any)?.metadata ?? {}
        setDefaults({
            default_rep: m.default_rep ?? "",
            default_order_type: m.default_order_type ?? "",
            default_lead_time: m.default_lead_time ?? "",
            default_payment_terms: m.default_payment_terms ?? "",
        })
    }, [data?.id])

    const persist = async (next: EstimateDefaults) => {
        setSaving(true)
        try {
            const r = await fetch(`/admin/customers/${data.id}`, {
                method: "POST",
                credentials: "include",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ metadata: next }),
            })
            if (!r.ok) throw new Error()
            toast.success("Customer defaults saved")
        } catch {
            toast.error("Failed to save defaults")
        } finally { setSaving(false) }
    }

    const update = (key: keyof EstimateDefaults, val: string) => {
        const next = { ...defaults, [key]: val }
        setDefaults(next)
        persist(next)
    }

    const labelClass = "text-[10px] font-bold text-ui-fg-muted uppercase tracking-wider mb-1 block"

    return (
        <Container>
            <div className="flex items-center justify-between mb-4">
                <div className="font-semibold text-sm">Customer Defaults</div>
                {saving && <Text size="xsmall" className="text-ui-fg-muted">Saving…</Text>}
            </div>
            <div className="grid grid-cols-2 gap-4">

                {/* Rep */}
                <div>
                    <label className={labelClass}>Default Rep</label>
                    {reps.length > 0 ? (
                        <Select value={defaults.default_rep} onValueChange={v => update("default_rep", v)}>
                            <Select.Trigger className="h-8 text-sm w-full"><Select.Value placeholder="Select rep…" /></Select.Trigger>
                            <Select.Content>
                                {reps.map(r => <Select.Item key={r.value} value={r.value}>{r.label}</Select.Item>)}
                            </Select.Content>
                        </Select>
                    ) : (
                        <Input value={defaults.default_rep} onChange={e => update("default_rep", e.target.value)} placeholder="e.g. AV" className="h-8 text-sm" />
                    )}
                </div>

                {/* Order Type */}
                <div>
                    <label className={labelClass}>Default Order Type</label>
                    <Select value={defaults.default_order_type} onValueChange={v => update("default_order_type", v)}>
                        <Select.Trigger className="h-8 text-sm w-full"><Select.Value placeholder="Select type…" /></Select.Trigger>
                        <Select.Content>
                            {options.order_types.map(t => <Select.Item key={t} value={t}>{t}</Select.Item>)}
                        </Select.Content>
                    </Select>
                </div>

                {/* Lead Time */}
                <div>
                    <label className={labelClass}>Default Lead Time</label>
                    <Select value={defaults.default_lead_time} onValueChange={v => update("default_lead_time", v)}>
                        <Select.Trigger className="h-8 text-sm w-full"><Select.Value placeholder="Select lead time…" /></Select.Trigger>
                        <Select.Content>
                            {options.lead_times.map(t => <Select.Item key={t} value={t}>{t}</Select.Item>)}
                        </Select.Content>
                    </Select>
                </div>

                {/* Payment Terms */}
                <div>
                    <label className={labelClass}>Default Payment Terms</label>
                    <Select value={defaults.default_payment_terms} onValueChange={v => update("default_payment_terms", v)}>
                        <Select.Trigger className="h-8 text-sm w-full"><Select.Value placeholder="Select terms…" /></Select.Trigger>
                        <Select.Content>
                            {options.payment_terms.map(t => <Select.Item key={t} value={t}>{t}</Select.Item>)}
                        </Select.Content>
                    </Select>
                </div>

            </div>
            <Text size="xsmall" className="text-ui-fg-muted mt-3">
                These defaults will pre-fill new draft orders for this customer.
            </Text>
        </Container>
    )
}

export default CustomerEstimateWidget

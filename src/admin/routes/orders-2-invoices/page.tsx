/**
 * orders-2-invoices/page.tsx
 * Invoices admin tab — shows real `pos_invoice` records from the DB.
 * GET /admin/invoices  (InvoiceModuleService)
 */
import { defineRouteConfig } from "@medusajs/admin-sdk"
import { DocumentText } from "@medusajs/icons"
import { useState, useEffect, useMemo, useCallback } from "react"
import { useNavigate } from "react-router-dom"
import { Container, Heading, Text, Badge, Button, Input, Select } from "@medusajs/ui"

// ─── Sidebar ─────────────────────────────────────────────────────────────────
export const config = defineRouteConfig({
    label: "Invoices",
    icon: DocumentText,
    nested: "/orders",
})

// ─── Types ────────────────────────────────────────────────────────────────────

interface InvoiceItem {
    id: string
    description: string
    quantity: number
    unit_price: number
    total: number
    sku?: string | null
}

interface PosInvoice {
    id: string
    invoice_number: string
    order_id: string
    fulfillment_id: string | null
    customer_id: string
    status: "draft" | "issued" | "partial" | "paid" | "voided"
    subtotal: number
    shipping: number
    tax: number
    total: number
    amount_paid: number
    balance_due: number
    payment_method: string
    issued_at: string | null
    paid_at: string | null
    voided_at: string | null
    void_reason: string | null
    notes: string | null
    created_by: string | null
    created_at: string
    items: InvoiceItem[]
    tracking_links?: Array<{ tracking_number: string; carrier?: string }>
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const fmt = (cents: number, cur = "usd") =>
    new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: cur.toUpperCase(),
        minimumFractionDigits: 2,
    }).format(cents / 100)

const fmtDate = (d: string | null) =>
    d ? new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—"

const STATUS_COLORS: Record<string, "orange" | "green" | "red" | "grey" | "blue" | "purple"> = {
    draft:   "grey",
    issued:  "blue",
    partial: "orange",
    paid:    "green",
    voided:  "red",
}

const PAYMENT_LABELS: Record<string, string> = {
    cash: "Cash", check: "Check", card: "Card",
    ach: "ACH / Wire", credit: "Store Credit", mixed: "Mixed",
}

// ─── QB metadata helpers ──────────────────────────────────────────────────────

interface QbMeta {
    ref: string | null
    synced: boolean
    customerDisplay?: string
}

function extractQbMeta(meta: Record<string, unknown> | null | undefined): QbMeta {
    if (!meta) return { ref: null, synced: false }
    // New consolidated shape: qb_invoice (object) or qb_invoices (array)
    const invObj = meta.qb_invoice
    const invArr = Array.isArray(meta.qb_invoices) ? meta.qb_invoices : []
    const latestInv = invArr.length > 0 ? invArr[invArr.length - 1] : null
    const ref = (
        (invObj && typeof invObj === "object" ? (invObj as any).ref_number : null) ??
        (latestInv?.ref_number ?? null) ??
        (meta.qb_invoice_ref as string | null) ??
        null
    )
    const txnId = (
        (invObj && typeof invObj === "object" ? (invObj as any).txn_id : null) ??
        (latestInv?.txn_id ?? null) ??
        (meta.qb_invoice_txn_id as string | null) ??
        null
    )
    return { ref: ref ?? null, synced: !!(txnId || ref) }
}

type SortKey = "date_desc" | "date_asc" | "total_desc" | "total_asc" | "invoice_desc" | "invoice_asc"

const SORT_OPTIONS: { value: SortKey; label: string }[] = [
    { value: "date_desc",    label: "Date (Newest)" },
    { value: "date_asc",     label: "Date (Oldest)" },
    { value: "total_desc",   label: "Total (High → Low)" },
    { value: "total_asc",    label: "Total (Low → High)" },
    { value: "invoice_desc", label: "Invoice # (Desc)" },
    { value: "invoice_asc",  label: "Invoice # (Asc)" },
]

const PAGE_SIZE = 20

// ─── Detail Modal ─────────────────────────────────────────────────────────────

interface InvoiceDetailProps {
    inv: PosInvoice
    navigate: ReturnType<typeof useNavigate>
    onClose: () => void
}

const InvoiceDetailModal = ({ inv, navigate, onClose }: InvoiceDetailProps) => {
    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
             onClick={e => { if (e.target === e.currentTarget) onClose() }}>
            <div className="bg-ui-bg-base border border-ui-border-base rounded-xl shadow-2xl w-full max-w-2xl mx-4 overflow-hidden max-h-[90vh] flex flex-col">
                {/* Header */}
                <div className="flex items-center justify-between px-6 py-4 border-b border-ui-border-base flex-shrink-0">
                    <div>
                        <Text weight="plus" size="large">{inv.invoice_number}</Text>
                        <div className="flex items-center gap-2 mt-1">
                            <Badge color={STATUS_COLORS[inv.status] ?? "grey"} size="small">
                                {inv.status.charAt(0).toUpperCase() + inv.status.slice(1)}
                            </Badge>
                            {inv.issued_at && (
                                <Text size="xsmall" className="text-ui-fg-muted">{fmtDate(inv.issued_at)}</Text>
                            )}
                        </div>
                    </div>
                    <div className="flex items-center gap-2">
                        <Button
                            size="small" variant="secondary"
                            onClick={() => { onClose(); navigate(`/orders/${inv.order_id}`) }}
                        >
                            View Order ↗
                        </Button>
                        <button onClick={onClose} className="text-ui-fg-muted hover:text-ui-fg-base transition-colors ml-1">
                            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                            </svg>
                        </button>
                    </div>
                </div>

                {/* Body */}
                <div className="flex-1 overflow-y-auto min-h-0 px-6 py-5 flex flex-col gap-5">
                    {/* Meta grid */}
                    <div className="grid grid-cols-3 gap-4 text-xs">
                        <div className="space-y-1.5">
                            <Text size="xsmall" weight="plus" className="text-ui-fg-muted uppercase tracking-wider">Invoice</Text>
                            <div><Text size="small" className="text-ui-fg-muted">Number:</Text>{" "}
                                <Text size="small" weight="plus" className="font-mono">{inv.invoice_number}</Text>
                            </div>
                            {inv.issued_at && <div>
                                <Text size="small" className="text-ui-fg-muted">Issued:</Text>{" "}
                                <Text size="small">{fmtDate(inv.issued_at)}</Text>
                            </div>}
                            {inv.voided_at && <div>
                                <Text size="small" className="text-ui-fg-muted">Voided:</Text>{" "}
                                <Text size="small" className="text-ui-fg-error">{fmtDate(inv.voided_at)}</Text>
                            </div>}
                            {inv.void_reason && <div>
                                <Text size="small" className="text-ui-fg-muted">Reason:</Text>{" "}
                                <Text size="small">{inv.void_reason}</Text>
                            </div>}
                        </div>
                        <div className="space-y-1.5">
                            <Text size="xsmall" weight="plus" className="text-ui-fg-muted uppercase tracking-wider">Payment</Text>
                            <div>
                                <Text size="small" className="text-ui-fg-muted">Method:</Text>{" "}
                                <Text size="small">{PAYMENT_LABELS[inv.payment_method] ?? inv.payment_method}</Text>
                            </div>
                            {inv.created_by && <div>
                                <Text size="small" className="text-ui-fg-muted">Created by:</Text>{" "}
                                <Text size="small">{inv.created_by}</Text>
                            </div>}
                        </div>
                        {inv.notes && (
                            <div className="space-y-1.5">
                                <Text size="xsmall" weight="plus" className="text-ui-fg-muted uppercase tracking-wider">Notes</Text>
                                <Text size="small" className="text-ui-fg-subtle">{inv.notes}</Text>
                            </div>
                        )}
                    </div>

                    {/* Items table */}
                    <div>
                        <Text size="xsmall" weight="plus" className="text-ui-fg-muted uppercase tracking-wider mb-2">Items</Text>
                        <div className="border border-ui-border-base rounded-lg overflow-hidden">
                            <div className="grid grid-cols-[1fr_60px_90px_90px] px-3 py-2 bg-ui-bg-subtle border-b border-ui-border-base">
                                {["Description", "Qty", "Unit Price", "Total"].map((h, i) => (
                                    <Text key={h} size="xsmall" weight="plus"
                                        className={`text-ui-fg-muted uppercase tracking-wider ${i > 0 ? "text-right" : ""}`}>
                                        {h}
                                    </Text>
                                ))}
                            </div>
                            {(inv.items ?? []).map(item => (
                                <div key={item.id} className="grid grid-cols-[1fr_60px_90px_90px] items-start px-3 py-2.5 border-b border-ui-border-base last:border-0">
                                    <div>
                                        <Text size="small" weight="plus">{item.description}</Text>
                                        {item.sku && <Text size="xsmall" className="text-ui-fg-muted font-mono">{item.sku}</Text>}
                                    </div>
                                    <Text size="small" className="text-right text-ui-fg-muted">{item.quantity}</Text>
                                    <Text size="small" className="text-right">{fmt(item.unit_price)}</Text>
                                    <Text size="small" className="text-right" weight="plus">{fmt(item.total)}</Text>
                                </div>
                            ))}
                        </div>
                    </div>

                    {/* Totals */}
                    <div className="flex justify-end">
                        <div className="w-64 space-y-1.5">
                            {[
                                { label: "Subtotal", val: inv.subtotal, muted: true },
                                { label: "Shipping", val: inv.shipping ?? 0, muted: true },
                                { label: "Tax", val: inv.tax, muted: true },
                            ].map(({ label, val, muted }) => (
                                <div key={label} className="flex justify-between">
                                    <Text size="small" className="text-ui-fg-muted">{label}</Text>
                                    <Text size="small" className={muted ? "text-ui-fg-muted" : ""}>{fmt(val)}</Text>
                                </div>
                            ))}
                            <div className="flex justify-between border-t border-ui-border-base pt-1.5">
                                <Text size="small" weight="plus">Total</Text>
                                <Text size="small" weight="plus">{fmt(inv.total)}</Text>
                            </div>
                            <div className="flex justify-between">
                                <Text size="small" className="text-ui-fg-muted">Paid</Text>
                                <Text size="small" className="text-green-600 font-medium">{fmt(inv.amount_paid)}</Text>
                            </div>
                            <div className="flex justify-between">
                                <Text size="small" weight="plus">Balance</Text>
                                <Text size="small" weight="plus" className={inv.balance_due > 0 ? "text-orange-500" : "text-green-600"}>
                                    {fmt(inv.balance_due)}
                                </Text>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    )
}

// ─── Column layout ─────────────────────────────────────────────────────────────

const COLS = "grid-cols-[130px_90px_100px_100px_minmax(180px,1fr)_100px_130px_110px_100px_80px]"
const HEADERS = ["Invoice #", "QB Ref #", "Order #", "Date", "Customer", "Status", "Payment", "Total", "Balance", "QB Sync"]

// ─── Page ─────────────────────────────────────────────────────────────────────

const InvoicesPage = () => {
    const navigate = useNavigate()
    const [invoices, setInvoices] = useState<PosInvoice[]>([])
    const [orderMeta, setOrderMeta] = useState<Record<string, QbMeta>>({})
    const [loading, setLoading] = useState(true)
    const [search, setSearch] = useState("")
    const [sort, setSort] = useState<SortKey>("date_desc")
    const [page, setPage] = useState(0)
    const [selectedInvoice, setSelectedInvoice] = useState<PosInvoice | null>(null)

    const fetchInvoices = useCallback(async () => {
        setLoading(true)
        try {
            const r = await fetch(`/admin/invoices`, { credentials: "include" })
            if (!r.ok) return
            const json = await r.json()
            const invList: PosInvoice[] = json.invoices ?? []
            setInvoices(invList)

            // Batch-fetch order metadata for QB columns
            const orderIds = [...new Set(invList.map(i => i.order_id))]
            if (orderIds.length > 0) {
                const idsParam = orderIds.map(id => `id[]=${id}`).join("&")
                const or = await fetch(`/admin/orders?${idsParam}&fields=id,metadata,*customer&limit=100`, { credentials: "include" })
                if (or.ok) {
                    const oj = await or.json()
                    const map: Record<string, QbMeta> = {}
                    for (const o of (oj.orders ?? [])) {
                        const meta = extractQbMeta(o.metadata)
                        
                        let customerDisplay = undefined
                        if (o.customer) {
                            const parts = []
                            if (o.customer.first_name || o.customer.last_name) {
                                parts.push([o.customer.first_name, o.customer.last_name].filter(Boolean).join(" "))
                            }
                            if (o.customer.company_name) {
                                parts.push(o.customer.company_name)
                            }
                            if (parts.length > 0) {
                                customerDisplay = parts.join(" — ")
                            } else if (o.customer.email) {
                                customerDisplay = o.customer.email
                            }
                        }
                        
                        map[o.id] = { ...meta, customerDisplay }
                    }
                    setOrderMeta(map)
                }
            }
        } catch (err) {
            console.error("[InvoicesPage] fetch failed", err)
        } finally {
            setLoading(false)
        }
    }, [])

    useEffect(() => { fetchInvoices() }, [fetchInvoices])

    const filtered = useMemo(() => {
        if (!search.trim()) return invoices
        const q = search.toLowerCase()
        return invoices.filter(inv =>
            inv.invoice_number.toLowerCase().includes(q) ||
            inv.order_id.toLowerCase().includes(q) ||
            inv.customer_id.toLowerCase().includes(q) ||
            (inv.notes ?? "").toLowerCase().includes(q)
        )
    }, [invoices, search])

    const sorted = useMemo(() => {
        const arr = [...filtered]
        switch (sort) {
            case "date_desc":    return arr.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
            case "date_asc":     return arr.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
            case "total_desc":   return arr.sort((a, b) => b.total - a.total)
            case "total_asc":    return arr.sort((a, b) => a.total - b.total)
            case "invoice_desc": return arr.sort((a, b) => b.invoice_number.localeCompare(a.invoice_number))
            case "invoice_asc":  return arr.sort((a, b) => a.invoice_number.localeCompare(b.invoice_number))
        }
    }, [filtered, sort])

    const totalPages = Math.ceil(sorted.length / PAGE_SIZE)
    const paginated = sorted.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)

    return (
        <>
            <div className="flex flex-col gap-4 p-6">
                <div className="flex items-center justify-between">
                    <div>
                        <Heading level="h1">Invoices</Heading>
                        <Text className="text-ui-fg-subtle text-sm mt-1">
                            POS invoices generated from fulfilled orders.
                            {!loading && <span className="ml-1 text-ui-fg-muted">({sorted.length})</span>}
                        </Text>
                    </div>
                    <Button variant="secondary" size="small" onClick={() => fetchInvoices()} disabled={loading}>
                        Refresh
                    </Button>
                </div>

                <Container className="divide-y p-0 overflow-hidden">
                    {/* Controls */}
                    <div className="flex items-center gap-3 flex-wrap px-4 py-3">
                        <Input
                            placeholder="Search by invoice #, order ID, customer..."
                            value={search}
                            onChange={e => { setSearch(e.target.value); setPage(0) }}
                            className="max-w-sm"
                        />
                        <div className="flex items-center gap-2 ml-auto">
                            <Text size="small" className="text-ui-fg-subtle whitespace-nowrap">Sort by:</Text>
                            <Select value={sort} onValueChange={v => { setSort(v as SortKey); setPage(0) }}>
                                <Select.Trigger className="w-52"><Select.Value /></Select.Trigger>
                                <Select.Content>
                                    {SORT_OPTIONS.map(o => (
                                        <Select.Item key={o.value} value={o.value}>{o.label}</Select.Item>
                                    ))}
                                </Select.Content>
                            </Select>
                        </div>
                    </div>

                    {/* Table */}
                    <div className="overflow-x-auto">
                        {loading ? (
                            <div className="p-6">
                                <Text size="small" className="text-ui-fg-muted">Loading invoices...</Text>
                            </div>
                        ) : sorted.length === 0 ? (
                            <div className="p-6 flex flex-col items-center justify-center gap-2 py-10">
                                <Text size="small" className="text-ui-fg-subtle">
                                    {search ? `No invoices matching "${search}"` : "No invoices yet. Create an invoice from an order in the POS."}
                                </Text>
                            </div>
                        ) : (
                            <div className="min-w-[900px]">
                                {/* Header */}
                                <div className={`grid ${COLS} gap-x-3 px-4 py-2 bg-ui-bg-subtle border-b border-ui-border-base`}>
                                    {HEADERS.map((h, i) => (
                                        <Text key={i} size="xsmall" weight="plus"
                                            className={`text-ui-fg-muted uppercase tracking-wider ${i >= 6 ? "text-right" : ""}`}>
                                            {h}
                                        </Text>
                                    ))}
                                </div>
                                {/* Rows */}
                                {paginated.map(inv => {
                                    const qb = orderMeta[inv.order_id] ?? { ref: null, synced: false }
                                    return (
                                    <div
                                        key={inv.id}
                                        className={`grid ${COLS} gap-x-3 px-4 py-3 border-b border-ui-border-base hover:bg-ui-bg-subtle-hover transition-colors cursor-pointer items-center`}
                                        onClick={() => setSelectedInvoice(inv)}
                                    >
                                        <Text size="small" weight="plus" className="font-mono">{inv.invoice_number}</Text>
                                        {/* QB Ref # */}
                                        <Text size="small" className="font-mono text-ui-fg-subtle truncate" title={qb.ref ?? undefined}>
                                            {qb.ref ?? "—"}
                                        </Text>
                                        {/* Order # */}
                                        <Text size="small" className="text-ui-fg-subtle truncate font-mono" title={inv.order_id}>
                                            ...{inv.order_id.slice(-8)}
                                        </Text>
                                        <Text size="small" className="text-ui-fg-subtle">{fmtDate(inv.issued_at ?? inv.created_at)}</Text>
                                        <Text size="small" className={qb.customerDisplay ? "text-ui-fg-base truncate" : "text-ui-fg-subtle truncate font-mono text-xs"} title={qb.customerDisplay ?? inv.customer_id}>
                                            {qb.customerDisplay ?? `...${inv.customer_id.slice(-10)}`}
                                        </Text>
                                        <div>
                                            <Badge color={STATUS_COLORS[inv.status] ?? "grey"} size="small">
                                                {inv.status.charAt(0).toUpperCase() + inv.status.slice(1)}
                                            </Badge>
                                        </div>
                                        <Text size="small" className="text-ui-fg-subtle">
                                            {PAYMENT_LABELS[inv.payment_method] ?? inv.payment_method}
                                        </Text>
                                        <Text size="small" className="text-right font-medium">{fmt(inv.total)}</Text>
                                        <Text size="small" className={`text-right font-medium ${inv.balance_due > 0 ? "text-orange-500" : "text-green-600"}`}>
                                            {fmt(inv.balance_due)}
                                        </Text>
                                        {/* QB Sync */}
                                        <div className="flex justify-center">
                                            {qb.synced
                                                ? <span title="Synced to QuickBooks" className="text-green-500 font-bold text-base leading-none">✓</span>
                                                : <span title="Not synced" className="text-ui-fg-muted text-base leading-none">—</span>
                                            }
                                        </div>
                                    </div>
                                    )
                                })}
                            </div>
                        )}
                    </div>

                    {/* Footer */}
                    <div className="flex items-center justify-between px-4 py-3">
                        <Text size="xsmall" className="text-ui-fg-muted">
                            {!loading && `${sorted.length} invoice${sorted.length !== 1 ? "s" : ""}`}
                        </Text>
                        {totalPages > 1 && (
                            <div className="flex items-center gap-3">
                                <Text size="xsmall" className="text-ui-fg-muted">
                                    {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, sorted.length)} of {sorted.length}
                                </Text>
                                <div className="flex gap-2">
                                    <Button variant="secondary" size="small" disabled={page === 0} onClick={() => setPage(p => p - 1)}>← Prev</Button>
                                    <Button variant="secondary" size="small" disabled={page >= totalPages - 1} onClick={() => setPage(p => p + 1)}>Next →</Button>
                                </div>
                            </div>
                        )}
                    </div>
                </Container>
            </div>

            {/* Invoice Detail Modal */}
            {selectedInvoice && (
                <InvoiceDetailModal
                    inv={selectedInvoice}
                    navigate={navigate}
                    onClose={() => setSelectedInvoice(null)}
                />
            )}
        </>
    )
}

export default InvoicesPage

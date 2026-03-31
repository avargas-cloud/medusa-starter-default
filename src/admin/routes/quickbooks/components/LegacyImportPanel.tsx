import { Container, Heading, Text, Button, toast } from "@medusajs/ui"
import { useState, useEffect, useCallback } from "react"

// ── Types ─────────────────────────────────────────────────────────────────────

interface LegacySoRecord {
    qb_txn_id: string
    qb_ref_number: string
    qb_customer_name: string
    txn_date: string | null
    amount: number | string
    balance_remaining: number | string
    status: string
}

interface PaymentPreviewRecord {
    txn_id: string
    ref_number: string
    qb_customer_name: string
    medusa_customer_id: string | null
    medusa_customer_email: string | null
    amount_cents: number
    date: string
    method: string
    already_imported: boolean
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const fmt = (v: number | string) =>
    typeof v === "number"
        ? `$${v.toFixed(2)}`
        : `$${parseFloat(String(v) || "0").toFixed(2)}`

const fmtCents = (cents: number) => `$${(cents / 100).toFixed(2)}`

const fmtDate = (d: string | null) => {
    if (!d) return "—"
    try { return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) }
    catch { return d }
}

// ── Tab: Sales Orders ─────────────────────────────────────────────────────────

function SalesOrdersTab() {
    const [loading, setLoading] = useState(false)
    const [records, setRecords] = useState<LegacySoRecord[]>([])
    const [total, setTotal] = useState(0)
    const [fetched, setFetched] = useState(false)

    const loadExisting = useCallback(async () => {
        try {
            const r = await fetch("/admin/quickbooks/import/sales-orders", { credentials: "include" })
            if (!r.ok) return
            const data = await r.json()
            setRecords(data.records ?? [])
            setTotal(data.total ?? 0)
            setFetched(true)
        } catch (_) { /* table may not exist yet */ }
    }, [])

    useEffect(() => { loadExisting() }, [loadExisting])

    const handleImport = async () => {
        setLoading(true)
        try {
            const r = await fetch("/admin/quickbooks/import/sales-orders", {
                method: "POST",
                credentials: "include",
            })
            const data = await r.json()
            if (!r.ok || !data.success) {
                toast.error("Import failed", { description: data.error || "Unknown error" })
                return
            }
            setRecords(data.records ?? [])
            setTotal(data.total ?? 0)
            setFetched(true)
            toast.success("Sales Orders imported", {
                description: `${data.total} open SO${data.total !== 1 ? "s" : ""} loaded from QuickBooks`,
            })
        } catch (err: any) {
            toast.error("Import error", { description: err.message })
        } finally {
            setLoading(false)
        }
    }

    return (
        <div>
            <div className="flex items-center justify-between mb-3">
                <Text className="text-xs text-ui-fg-subtle">
                    Loads open (non-closed) Sales Orders from QB as reference data. No orders are created automatically — you create them manually using the TxnID and Ref# shown here.
                </Text>
                <Button
                    variant="secondary"
                    size="small"
                    onClick={handleImport}
                    isLoading={loading}
                    disabled={loading}
                    className="ml-4 shrink-0"
                >
                    {loading ? "Querying QB..." : "Import from QuickBooks"}
                </Button>
            </div>

            {fetched && total === 0 && (
                <Text className="text-xs text-ui-fg-muted italic">
                    No open Sales Orders on record — run import to load from QuickBooks.
                </Text>
            )}

            {records.length > 0 && (
                <div className="overflow-x-auto mt-1">
                    <table className="w-full text-xs border-collapse">
                        <thead>
                            <tr className="bg-ui-bg-subtle">
                                <th className="text-left px-2 py-1.5 text-ui-fg-subtle font-medium border-b border-ui-border-base">SO#</th>
                                <th className="text-left px-2 py-1.5 text-ui-fg-subtle font-medium border-b border-ui-border-base">Customer</th>
                                <th className="text-left px-2 py-1.5 text-ui-fg-subtle font-medium border-b border-ui-border-base">Date</th>
                                <th className="text-right px-2 py-1.5 text-ui-fg-subtle font-medium border-b border-ui-border-base">Amount</th>
                                <th className="text-right px-2 py-1.5 text-ui-fg-subtle font-medium border-b border-ui-border-base">Balance</th>
                                <th className="text-left px-2 py-1.5 text-ui-fg-subtle font-medium border-b border-ui-border-base">Status</th>
                            </tr>
                        </thead>
                        <tbody>
                            {records.map((so) => (
                                <tr key={so.qb_txn_id} className="border-b border-ui-border-base hover:bg-ui-bg-subtle">
                                    <td className="px-2 py-1.5 font-mono text-ui-fg-base">{so.qb_ref_number || "—"}</td>
                                    <td className="px-2 py-1.5 text-ui-fg-base">{so.qb_customer_name || "—"}</td>
                                    <td className="px-2 py-1.5 text-ui-fg-subtle">{fmtDate(so.txn_date)}</td>
                                    <td className="px-2 py-1.5 text-right text-ui-fg-base">{fmt(so.amount)}</td>
                                    <td className="px-2 py-1.5 text-right font-medium text-orange-600">{fmt(so.balance_remaining)}</td>
                                    <td className="px-2 py-1.5">
                                        <span className="inline-block rounded-full px-2 py-0.5 text-xs bg-orange-50 text-orange-700 border border-orange-200">
                                            {so.status}
                                        </span>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    )
}

// ── Tab: Unapplied Payments ───────────────────────────────────────────────────

function PaymentsTab() {
    const [previewLoading, setPreviewLoading] = useState(false)
    const [confirmLoading, setConfirmLoading] = useState(false)
    const [preview, setPreview] = useState<PaymentPreviewRecord[] | null>(null)
    const [previewStats, setPreviewStats] = useState<{ matched: number; unmatched: number; already: number } | null>(null)

    const handlePreview = async () => {
        setPreviewLoading(true)
        setPreview(null)
        setPreviewStats(null)
        try {
            const r = await fetch("/admin/quickbooks/import/payments", { credentials: "include" })
            const data = await r.json()
            if (!r.ok || !data.success) {
                toast.error("Preview failed", { description: data.error || "Unknown error" })
                return
            }
            setPreview(data.records ?? [])
            setPreviewStats({ matched: data.matched, unmatched: data.unmatched, already: data.already_imported })
        } catch (err: any) {
            toast.error("Preview error", { description: err.message })
        } finally {
            setPreviewLoading(false)
        }
    }

    const handleConfirm = async () => {
        setConfirmLoading(true)
        try {
            const r = await fetch("/admin/quickbooks/import/payments", {
                method: "POST",
                credentials: "include",
            })
            const data = await r.json()
            if (!r.ok || !data.success) {
                toast.error("Import failed", { description: data.error || "Unknown error" })
                return
            }
            const msg = [
                `${data.imported} payment${data.imported !== 1 ? "s" : ""} imported`,
                data.skipped > 0 ? `${data.skipped} skipped (no Medusa match)` : null,
            ].filter(Boolean).join(" — ")

            if (data.errors?.length > 0) {
                toast.warning("Partial import", { description: msg + ". Check console." })
                console.warn("[QB Import Payments] Errors:", data.errors)
            } else {
                toast.success("Payments imported", { description: msg })
            }
            // Refresh preview to show updated already_imported state
            setPreview(null)
            setPreviewStats(null)
        } catch (err: any) {
            toast.error("Import error", { description: err.message })
        } finally {
            setConfirmLoading(false)
        }
    }

    const toImportCount = preview?.filter(p => p.medusa_customer_id && !p.already_imported).length ?? 0

    return (
        <div>
            <div className="flex items-center justify-between mb-3">
                <Text className="text-xs text-ui-fg-subtle">
                    Fetches unapplied payments from QB and shows a preview before creating any records. Only payments matched to a Medusa customer (via QB customer ID) can be imported.
                </Text>
                <div className="flex items-center gap-2 ml-4 shrink-0">
                    {preview !== null && toImportCount > 0 && (
                        <Button
                            variant="primary"
                            size="small"
                            onClick={handleConfirm}
                            isLoading={confirmLoading}
                            disabled={confirmLoading || previewLoading}
                        >
                            {confirmLoading ? "Importing..." : `Confirm Import (${toImportCount})`}
                        </Button>
                    )}
                    <Button
                        variant="secondary"
                        size="small"
                        onClick={handlePreview}
                        isLoading={previewLoading}
                        disabled={previewLoading || confirmLoading}
                    >
                        {previewLoading ? "Querying QB..." : preview !== null ? "Refresh Preview" : "Preview Payments"}
                    </Button>
                </div>
            </div>

            {preview === null && !previewLoading && (
                <Text className="text-xs text-ui-fg-muted italic">
                    Click "Preview Payments" to fetch unapplied payments from QuickBooks. Nothing will be created until you confirm.
                </Text>
            )}

            {preview !== null && previewStats !== null && (
                <>
                    <div className="flex gap-4 mb-2">
                        <span className="text-xs text-green-700 font-medium">✓ {previewStats.matched} will be imported</span>
                        {previewStats.unmatched > 0 && (
                            <span className="text-xs text-ui-fg-muted">⊘ {previewStats.unmatched} unmatched (no Medusa customer)</span>
                        )}
                        {previewStats.already > 0 && (
                            <span className="text-xs text-ui-fg-muted">↩ {previewStats.already} already imported</span>
                        )}
                    </div>

                    {preview.length === 0 ? (
                        <Text className="text-xs text-ui-fg-muted italic">No unapplied payments found in QuickBooks.</Text>
                    ) : (
                        <div className="overflow-x-auto">
                            <table className="w-full text-xs border-collapse">
                                <thead>
                                    <tr className="bg-ui-bg-subtle">
                                        <th className="text-left px-2 py-1.5 text-ui-fg-subtle font-medium border-b border-ui-border-base">Customer (QB)</th>
                                        <th className="text-left px-2 py-1.5 text-ui-fg-subtle font-medium border-b border-ui-border-base">Medusa Match</th>
                                        <th className="text-left px-2 py-1.5 text-ui-fg-subtle font-medium border-b border-ui-border-base">Ref#</th>
                                        <th className="text-left px-2 py-1.5 text-ui-fg-subtle font-medium border-b border-ui-border-base">Date</th>
                                        <th className="text-left px-2 py-1.5 text-ui-fg-subtle font-medium border-b border-ui-border-base">Method</th>
                                        <th className="text-right px-2 py-1.5 text-ui-fg-subtle font-medium border-b border-ui-border-base">Amount</th>
                                        <th className="text-left px-2 py-1.5 text-ui-fg-subtle font-medium border-b border-ui-border-base">Status</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {preview.map((p) => (
                                        <tr key={p.txn_id} className="border-b border-ui-border-base hover:bg-ui-bg-subtle">
                                            <td className="px-2 py-1.5 text-ui-fg-base">{p.qb_customer_name}</td>
                                            <td className="px-2 py-1.5">
                                                {p.medusa_customer_id
                                                    ? <span className="text-green-700">{p.medusa_customer_email || p.medusa_customer_id}</span>
                                                    : <span className="text-ui-fg-muted">No match</span>
                                                }
                                            </td>
                                            <td className="px-2 py-1.5 font-mono text-ui-fg-subtle">{p.ref_number || "—"}</td>
                                            <td className="px-2 py-1.5 text-ui-fg-subtle">{fmtDate(p.date)}</td>
                                            <td className="px-2 py-1.5 text-ui-fg-subtle capitalize">{p.method}</td>
                                            <td className="px-2 py-1.5 text-right font-medium text-ui-fg-base">{fmtCents(p.amount_cents)}</td>
                                            <td className="px-2 py-1.5">
                                                {p.already_imported
                                                    ? <span className="inline-block rounded-full px-2 py-0.5 text-xs bg-ui-bg-subtle text-ui-fg-muted border border-ui-border-base">Already imported</span>
                                                    : p.medusa_customer_id
                                                        ? <span className="inline-block rounded-full px-2 py-0.5 text-xs bg-green-50 text-green-700 border border-green-200">Will import</span>
                                                        : <span className="inline-block rounded-full px-2 py-0.5 text-xs bg-ui-bg-subtle text-ui-fg-muted border border-ui-border-base">Will skip</span>
                                                }
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </>
            )}
        </div>
    )
}

// ── Main Panel ────────────────────────────────────────────────────────────────

type Tab = "sales-orders" | "payments"

export function LegacyImportPanel() {
    const [activeTab, setActiveTab] = useState<Tab>("sales-orders")

    const tabClass = (tab: Tab) =>
        `px-3 py-1.5 text-xs font-medium rounded-md cursor-pointer transition-colors ${
            activeTab === tab
                ? "bg-ui-bg-interactive text-ui-fg-on-color"
                : "text-ui-fg-subtle hover:text-ui-fg-base hover:bg-ui-bg-subtle"
        }`

    return (
        <Container>
            <div className="p-4">
                <div className="flex items-center justify-between mb-3">
                    <Heading level="h3" className="text-sm font-medium">
                        🗂️ Legacy QB Data Import
                    </Heading>
                    <div className="flex items-center gap-1 bg-ui-bg-subtle rounded-md p-0.5">
                        <button className={tabClass("sales-orders")} onClick={() => setActiveTab("sales-orders")}>
                            Open Sales Orders
                        </button>
                        <button className={tabClass("payments")} onClick={() => setActiveTab("payments")}>
                            Unapplied Payments
                        </button>
                    </div>
                </div>

                {activeTab === "sales-orders" && <SalesOrdersTab />}
                {activeTab === "payments" && <PaymentsTab />}
            </div>
        </Container>
    )
}

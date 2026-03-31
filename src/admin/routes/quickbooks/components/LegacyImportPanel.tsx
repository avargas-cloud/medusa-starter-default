import { Container, Heading, Text, Button, toast } from "@medusajs/ui"
import { useState, useEffect, useCallback } from "react"

interface LegacySoRecord {
    qb_txn_id: string
    qb_ref_number: string
    qb_customer_name: string
    txn_date: string | null
    amount: number | string
    balance_remaining: number | string
    status: string
    imported_at: string
}

interface SoImportResult {
    success: boolean
    imported: number
    total: number
    records: LegacySoRecord[]
    error?: string
}

interface PayImportResult {
    success: boolean
    imported: number
    skipped: number
    skipped_details: string[]
    errors: string[]
    total: number
    error?: string
}

export function LegacyImportPanel() {
    const [soLoading, setSoLoading] = useState(false)
    const [payLoading, setPayLoading] = useState(false)
    const [soRecords, setSoRecords] = useState<LegacySoRecord[]>([])
    const [soTotal, setSoTotal] = useState(0)
    const [soFetched, setSoFetched] = useState(false)

    const loadExistingRecords = useCallback(async () => {
        try {
            const r = await fetch("/admin/quickbooks/import/sales-orders", { credentials: "include" })
            if (!r.ok) return
            const data = await r.json()
            setSoRecords(data.records ?? [])
            setSoTotal(data.total ?? 0)
            setSoFetched(true)
        } catch (_) {
            // silently ignore — table might not exist yet
        }
    }, [])

    useEffect(() => {
        loadExistingRecords()
    }, [loadExistingRecords])

    const handleImportSalesOrders = async () => {
        setSoLoading(true)
        try {
            const r = await fetch("/admin/quickbooks/import/sales-orders", {
                method: "POST",
                credentials: "include",
            })
            const data: SoImportResult = await r.json()

            if (!r.ok || !data.success) {
                toast.error("Import failed", { description: data.error || "Unknown error" })
                return
            }

            setSoRecords(data.records ?? [])
            setSoTotal(data.total ?? 0)
            setSoFetched(true)
            toast.success("Sales Orders imported", {
                description: `${data.total} open SO${data.total !== 1 ? "s" : ""} imported from QuickBooks`,
            })
        } catch (err: any) {
            toast.error("Import error", { description: err.message })
        } finally {
            setSoLoading(false)
        }
    }

    const handleImportPayments = async () => {
        setPayLoading(true)
        try {
            const r = await fetch("/admin/quickbooks/import/payments", {
                method: "POST",
                credentials: "include",
            })
            const data: PayImportResult = await r.json()

            if (!r.ok || !data.success) {
                toast.error("Payment import failed", { description: data.error || "Unknown error" })
                return
            }

            const msg = [
                `${data.imported} payment${data.imported !== 1 ? "s" : ""} imported`,
                data.skipped > 0 ? `${data.skipped} skipped (no Medusa match)` : null,
            ].filter(Boolean).join(" — ")

            if (data.errors.length > 0) {
                toast.warning("Partial import", { description: msg + ". Check console for errors." })
                console.warn("[QB Import Payments] Errors:", data.errors)
            } else {
                toast.success("Payments imported", { description: msg })
            }

            if (data.skipped_details?.length > 0) {
                console.info("[QB Import Payments] Skipped (no customer match):", data.skipped_details)
            }
        } catch (err: any) {
            toast.error("Payment import error", { description: err.message })
        } finally {
            setPayLoading(false)
        }
    }

    const fmt = (v: number | string) =>
        typeof v === "number" ? `$${v.toFixed(2)}` : `$${parseFloat(String(v) || "0").toFixed(2)}`

    const fmtDate = (d: string | null) => {
        if (!d) return "—"
        try { return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) }
        catch { return d }
    }

    return (
        <Container>
            <div className="p-4">
                <div className="flex items-center justify-between mb-1">
                    <Heading level="h3" className="text-sm font-medium">
                        🗂️ Legacy QB Data Import
                    </Heading>
                    <div className="flex items-center gap-2">
                        <Button
                            variant="secondary"
                            size="small"
                            onClick={handleImportPayments}
                            isLoading={payLoading}
                            disabled={payLoading || soLoading}
                        >
                            {payLoading ? "Querying QB..." : "Import Unapplied Payments"}
                        </Button>
                        <Button
                            variant="secondary"
                            size="small"
                            onClick={handleImportSalesOrders}
                            isLoading={soLoading}
                            disabled={soLoading || payLoading}
                        >
                            {soLoading ? "Querying QB..." : "Import Open Sales Orders"}
                        </Button>
                    </div>
                </div>
                <Text className="text-xs text-ui-fg-subtle mb-3">
                    Imports existing QB records into Medusa as reference data.
                    QB Web Connector must be online. Unapplied payments require a matching Medusa customer (linked via QB customer ID).
                </Text>

                {soFetched && soTotal === 0 && (
                    <Text className="text-xs text-ui-fg-muted italic">No legacy SOs on record — run import to load from QuickBooks.</Text>
                )}

                {soRecords.length > 0 && (
                    <div className="mt-2">
                        <Text className="text-xs font-medium text-ui-fg-subtle mb-2">
                            Open Sales Orders ({soTotal})
                        </Text>
                        <div className="overflow-x-auto">
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
                                    {soRecords.map((so) => (
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
                    </div>
                )}
            </div>
        </Container>
    )
}

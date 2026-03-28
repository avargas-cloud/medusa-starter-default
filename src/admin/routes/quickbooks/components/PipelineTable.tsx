import { useEffect, useState, useCallback, useRef } from "react"
import { Container, Heading, Text, Button } from "@medusajs/ui"
import { ArrowPath } from "@medusajs/icons"

// ─── Types ────────────────────────────────────────────────────────────────────

type PipelineStatus = "pending" | "submitted" | "confirmed" | "failed" | "skipped"

interface PipelineRow {
    id: string
    order_id: string | null
    reference_id: string | null
    reference_type: string | null
    step: string
    status: PipelineStatus
    depends_on: string | null
    depends_on_step: string | null
    depends_on_status: string | null
    bridge_op_id: string | null
    retry_count: number
    qb_txn_id: string | null
    qb_ref_number: string | null
    error: string | null
    created_at: string
    submitted_at: string | null
    confirmed_at: string | null
    failed_at: string | null
}

interface PipelineCounts {
    pending?: number
    submitted?: number
    confirmed?: number
    failed?: number
    skipped?: number
}

// ─── Config ───────────────────────────────────────────────────────────────────

const STEP_LABELS: Record<string, string> = {
    estimate:      "Estimate",
    sales_order:   "Sales Order",
    sales_receipt: "Sales Receipt",
    invoice:       "Invoice",
    payment:       "Payment",
    apply_payment: "Apply Payment",
    credit_memo:   "Credit Memo",
    write_check:   "Write Check",
}

const STEP_ICONS: Record<string, string> = {
    estimate:      "📋",
    sales_order:   "🧾",
    sales_receipt: "🏷️",
    invoice:       "📄",
    payment:       "💳",
    apply_payment: "🔗",
    credit_memo:   "↩️",
    write_check:   "✍️",
}

const REF_TYPE_LABELS: Record<string, string> = {
    order:       "Order",
    credit_memo: "Return",
    pos_invoice: "Invoice",
}

// ─── Status Badge ─────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: PipelineStatus }) {
    const map: Record<PipelineStatus, { color: string; label: string }> = {
        pending:   { color: "bg-yellow-100 text-yellow-800 border-yellow-200",  label: "Pending"   },
        submitted: { color: "bg-blue-100 text-blue-800 border-blue-200",        label: "Submitted" },
        confirmed: { color: "bg-green-100 text-green-800 border-green-200",     label: "Confirmed" },
        failed:    { color: "bg-red-100 text-red-800 border-red-200",           label: "Failed"    },
        skipped:   { color: "bg-gray-100 text-gray-600 border-gray-200",        label: "Skipped"   },
    }
    const s = map[status] ?? { color: "bg-gray-100 text-gray-600 border-gray-200", label: status }
    return (
        <span className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-semibold border ${s.color}`}>
            {s.label}
        </span>
    )
}

// ─── Relative time ────────────────────────────────────────────────────────────

function relTime(iso: string | null): string {
    if (!iso) return "—"
    const diff = Date.now() - new Date(iso).getTime()
    const s = Math.floor(diff / 1000)
    if (s < 60)  return `${s}s ago`
    const m = Math.floor(s / 60)
    if (m < 60)  return `${m}m ago`
    const h = Math.floor(m / 60)
    if (h < 24)  return `${h}h ago`
    return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" })
}

// ─── Row component ────────────────────────────────────────────────────────────

function PipelineRow({ row, onRetry, retrying }: {
    row: PipelineRow
    onRetry: (id: string) => void
    retrying: boolean
}) {
    const [expanded, setExpanded] = useState(false)
    const icon  = STEP_ICONS[row.step]  ?? "📎"
    const label = STEP_LABELS[row.step] ?? row.step
    const refLabel = row.reference_type ? (REF_TYPE_LABELS[row.reference_type] ?? row.reference_type) : "—"
    const refId = row.order_id ?? row.reference_id ?? "—"
    const shortRef = refId !== "—" ? refId.slice(-8) : "—"

    return (
        <>
            <tr
                className={`border-b border-ui-border-base text-xs transition-colors ${
                    row.status === "failed" ? "bg-red-50/40" :
                    row.status === "pending" ? "bg-yellow-50/20" :
                    row.status === "submitted" ? "bg-blue-50/20" : ""
                }`}
            >
                {/* Step */}
                <td className="px-3 py-2 whitespace-nowrap">
                    <span className="flex items-center gap-1.5">
                        <span>{icon}</span>
                        <span className="font-medium text-ui-fg-base">{label}</span>
                    </span>
                </td>

                {/* Reference */}
                <td className="px-3 py-2 whitespace-nowrap text-ui-fg-subtle">
                    <span className="text-[10px] font-medium text-ui-fg-muted uppercase mr-1">{refLabel}</span>
                    <span className="font-mono">…{shortRef}</span>
                </td>

                {/* Status */}
                <td className="px-3 py-2">
                    <StatusBadge status={row.status} />
                </td>

                {/* Depends on */}
                <td className="px-3 py-2 text-ui-fg-subtle">
                    {row.depends_on_step ? (
                        <span className="flex items-center gap-1">
                            <span className="text-ui-fg-muted">{STEP_LABELS[row.depends_on_step] ?? row.depends_on_step}</span>
                            {row.depends_on_status === "confirmed" ? (
                                <span className="text-green-600">✓</span>
                            ) : (
                                <span className="text-yellow-600">⏳</span>
                            )}
                        </span>
                    ) : (
                        <span className="text-ui-fg-muted">—</span>
                    )}
                </td>

                {/* QB TxnID */}
                <td className="px-3 py-2 font-mono text-ui-fg-subtle">
                    {row.qb_txn_id ? (
                        <span className="text-green-700 font-semibold">{row.qb_txn_id}</span>
                    ) : row.bridge_op_id ? (
                        <span className="text-blue-600 text-[10px]">op:{row.bridge_op_id.slice(-6)}</span>
                    ) : (
                        <span className="text-ui-fg-muted">—</span>
                    )}
                </td>

                {/* Retries */}
                <td className="px-3 py-2 text-center text-ui-fg-muted">
                    {row.retry_count > 0 ? (
                        <span className="text-orange-600 font-semibold">{row.retry_count}</span>
                    ) : "0"}
                </td>

                {/* Time */}
                <td className="px-3 py-2 text-ui-fg-muted whitespace-nowrap">
                    {relTime(row.confirmed_at ?? row.failed_at ?? row.submitted_at ?? row.created_at)}
                </td>

                {/* Actions */}
                <td className="px-3 py-2">
                    <div className="flex items-center gap-1">
                        {row.error && (
                            <button
                                onClick={() => setExpanded(v => !v)}
                                className="text-[10px] text-red-600 hover:underline"
                            >
                                {expanded ? "▲ hide" : "▼ error"}
                            </button>
                        )}
                        {row.status === "failed" && (
                            <button
                                onClick={() => onRetry(row.id)}
                                disabled={retrying}
                                className="ml-1 px-2 py-0.5 rounded text-[10px] font-semibold bg-ui-button-neutral hover:bg-ui-button-neutral-hover text-ui-fg-base border border-ui-border-base disabled:opacity-50"
                            >
                                {retrying ? "…" : "Retry"}
                            </button>
                        )}
                    </div>
                </td>
            </tr>

            {/* Error expansion row */}
            {expanded && row.error && (
                <tr className="bg-red-50 border-b border-red-200">
                    <td colSpan={8} className="px-4 py-2">
                        <pre className="text-[10px] text-red-700 whitespace-pre-wrap break-all font-mono">
                            {row.error}
                        </pre>
                    </td>
                </tr>
            )}
        </>
    )
}

// ─── Main Component ───────────────────────────────────────────────────────────

export function PipelineTable() {
    const [rows, setRows]       = useState<PipelineRow[]>([])
    const [counts, setCounts]   = useState<PipelineCounts>({})
    const [total, setTotal]     = useState(0)
    const [loading, setLoading] = useState(false)
    const [statusFilter, setStatusFilter] = useState<string>("all")
    const [stepFilter, setStepFilter]     = useState<string>("all")
    const [retryingId, setRetryingId]     = useState<string | null>(null)
    const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

    const fetchPipeline = useCallback(async (silent = false) => {
        if (!silent) setLoading(true)
        try {
            const params = new URLSearchParams({ limit: "50" })
            if (statusFilter !== "all") params.set("status", statusFilter)
            if (stepFilter   !== "all") params.set("step",   stepFilter)

            const res = await fetch(`/admin/quickbooks/pipeline?${params}`, { credentials: "include" })
            if (!res.ok) return
            const data = await res.json()
            setRows(data.pipeline ?? [])
            setCounts(data.counts  ?? {})
            setTotal(data.pagination?.total ?? 0)
        } catch { /* non-blocking */ } finally {
            if (!silent) setLoading(false)
        }
    }, [statusFilter, stepFilter])

    // Initial load + filter changes
    useEffect(() => { fetchPipeline() }, [fetchPipeline])

    // Auto-refresh every 10s while pending/submitted rows exist
    useEffect(() => {
        const hasPending = (counts.pending ?? 0) > 0 || (counts.submitted ?? 0) > 0
        if (intervalRef.current) clearInterval(intervalRef.current)
        if (hasPending) {
            intervalRef.current = setInterval(() => fetchPipeline(true), 10_000)
        }
        return () => { if (intervalRef.current) clearInterval(intervalRef.current) }
    }, [counts.pending, counts.submitted, fetchPipeline])

    const handleRetry = async (id: string) => {
        setRetryingId(id)
        try {
            const res = await fetch(`/admin/quickbooks/pipeline?action=retry&id=${id}`, {
                method: "POST",
                credentials: "include",
            })
            if (res.ok) await fetchPipeline(true)
        } catch { /* non-blocking */ } finally {
            setRetryingId(null)
        }
    }

    const hasPending = (counts.pending ?? 0) > 0 || (counts.submitted ?? 0) > 0

    return (
        <Container>
            <div className="p-4">
                {/* Header */}
                <div className="flex items-center justify-between mb-3">
                    <div>
                        <Heading level="h3" className="text-sm font-medium flex items-center gap-2">
                            ⚡ QB Operations Pipeline
                            {hasPending && (
                                <span className="inline-flex items-center gap-1 text-[10px] font-normal text-blue-600 animate-pulse">
                                    <span className="w-1.5 h-1.5 rounded-full bg-blue-500 inline-block" />
                                    Live
                                </span>
                            )}
                        </Heading>
                        <Text className="text-xs text-ui-fg-subtle mt-0.5">
                            Real-time queue of QuickBooks document operations — auto-refreshes while active
                        </Text>
                    </div>
                    <Button
                        variant="secondary"
                        size="small"
                        onClick={() => fetchPipeline()}
                        isLoading={loading}
                    >
                        <ArrowPath className="mr-1" />
                        Refresh
                    </Button>
                </div>

                {/* Summary badges */}
                <div className="flex items-center gap-2 mb-3 flex-wrap">
                    {[
                        { key: "pending",   label: "Pending",   color: "bg-yellow-100 text-yellow-800 border-yellow-200" },
                        { key: "submitted", label: "Submitted", color: "bg-blue-100 text-blue-800 border-blue-200"       },
                        { key: "confirmed", label: "Confirmed", color: "bg-green-100 text-green-800 border-green-200"    },
                        { key: "failed",    label: "Failed",    color: "bg-red-100 text-red-800 border-red-200"          },
                        { key: "skipped",   label: "Skipped",   color: "bg-gray-100 text-gray-600 border-gray-200"       },
                    ].map(({ key, label, color }) => {
                        const count = counts[key as keyof PipelineCounts] ?? 0
                        if (count === 0) return null
                        return (
                            <span key={key} className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-semibold border ${color}`}>
                                {label} <span className="font-bold">{count}</span>
                            </span>
                        )
                    })}
                    {Object.values(counts).every(v => !v || v === 0) && (
                        <span className="text-xs text-ui-fg-muted">No operations recorded yet</span>
                    )}
                </div>

                {/* Filters */}
                <div className="flex items-center gap-2 mb-3">
                    <select
                        value={statusFilter}
                        onChange={e => setStatusFilter(e.target.value)}
                        className="text-xs border border-ui-border-base rounded px-2 py-1 bg-ui-bg-base text-ui-fg-base"
                    >
                        <option value="all">All Statuses</option>
                        <option value="pending">Pending</option>
                        <option value="submitted">Submitted</option>
                        <option value="confirmed">Confirmed</option>
                        <option value="failed">Failed</option>
                        <option value="skipped">Skipped</option>
                    </select>
                    <select
                        value={stepFilter}
                        onChange={e => setStepFilter(e.target.value)}
                        className="text-xs border border-ui-border-base rounded px-2 py-1 bg-ui-bg-base text-ui-fg-base"
                    >
                        <option value="all">All Steps</option>
                        <option value="estimate">Estimate</option>
                        <option value="sales_order">Sales Order</option>
                        <option value="sales_receipt">Sales Receipt</option>
                        <option value="invoice">Invoice</option>
                        <option value="payment">Payment</option>
                        <option value="apply_payment">Apply Payment</option>
                        <option value="credit_memo">Credit Memo</option>
                        <option value="write_check">Write Check</option>
                    </select>
                    <span className="text-xs text-ui-fg-muted ml-auto">
                        {total} total operation{total !== 1 ? "s" : ""}
                    </span>
                </div>

                {/* Table */}
                {rows.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-10 text-center">
                        <Text className="text-sm text-ui-fg-subtle">No pipeline operations found.</Text>
                        <Text className="text-xs text-ui-fg-muted mt-1">
                            Operations appear here when orders sync to QuickBooks.
                        </Text>
                    </div>
                ) : (
                    <div className="overflow-x-auto rounded border border-ui-border-base">
                        <table className="w-full text-xs">
                            <thead className="bg-ui-bg-subtle border-b border-ui-border-base">
                                <tr>
                                    <th className="px-3 py-2 text-left font-semibold text-ui-fg-subtle">Step</th>
                                    <th className="px-3 py-2 text-left font-semibold text-ui-fg-subtle">Reference</th>
                                    <th className="px-3 py-2 text-left font-semibold text-ui-fg-subtle">Status</th>
                                    <th className="px-3 py-2 text-left font-semibold text-ui-fg-subtle">Depends On</th>
                                    <th className="px-3 py-2 text-left font-semibold text-ui-fg-subtle">QB TxnID</th>
                                    <th className="px-3 py-2 text-center font-semibold text-ui-fg-subtle">Retries</th>
                                    <th className="px-3 py-2 text-left font-semibold text-ui-fg-subtle">Time</th>
                                    <th className="px-3 py-2 text-left font-semibold text-ui-fg-subtle">Actions</th>
                                </tr>
                            </thead>
                            <tbody>
                                {rows.map(row => (
                                    <PipelineRow
                                        key={row.id}
                                        row={row}
                                        onRetry={handleRetry}
                                        retrying={retryingId === row.id}
                                    />
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>
        </Container>
    )
}

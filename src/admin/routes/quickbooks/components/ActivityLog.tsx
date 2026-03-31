import { useEffect, useState, useCallback } from "react"
import { Container, Heading, Text, Button, Badge, Select } from "@medusajs/ui"
import { ArrowPath } from "@medusajs/icons"

// ─── Types ────────────────────────────────────────────────────────────────────

type LogStatus = "processing" | "completed" | "failed" | "skipped"

interface ChangedItem {
    sku: string
    name: string
    prev: number
    next: number
    delta: number
    anomaly?: boolean
}

interface LogEntry {
    id: string
    operation: string
    status: LogStatus
    order_id: string | null
    order_display_id: number | null
    draft_order_id: string | null
    event_type: string | null
    sync_type: string | null
    triggered_by: string | null
    message: string | null
    error: string | null
    qb_txn_id: string | null
    qb_ref_number: string | null
    duration_ms: number | null
    initiated_at: string
    completed_at: string | null
    server_host: string | null
    metadata?: { changedItems?: ChangedItem[] } | null
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const OPERATION_LABELS: Record<string, string> = {
    sales_order: "Sales Order",
    estimate: "Estimate",
    payment: "Payment",
    invoice: "Invoice",
    cancel: "Cancellation",
    customer_transfer: "Customer Transfer",
    inventory_sync: "Inventory Sync",
    price_sync: "Price Sync",
    customer_sync: "Customer Sync",
}

const OPERATION_ICONS: Record<string, string> = {
    sales_order: "🧾",
    estimate: "📋",
    payment: "💳",
    invoice: "📄",
    cancel: "❌",
    customer_transfer: "👤",
    inventory_sync: "📦",
    price_sync: "💵",
    customer_sync: "👥",
}

const STATUS_COLORS: Record<LogStatus, "green" | "red" | "blue" | "grey"> = {
    completed: "green",
    failed: "red",
    processing: "blue",
    skipped: "grey",
}

const STATUS_LABELS: Record<LogStatus, string> = {
    completed: "Completed",
    failed: "Failed",
    processing: "Processing",
    skipped: "Skipped",
}

function formatDate(dateStr: string): string {
    try {
        return new Date(dateStr).toLocaleString('en-US', {
            month: 'short', day: 'numeric',
            hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true,
        })
    } catch { return dateStr }
}

function formatDuration(ms: number | null): string {
    if (ms === null) return ''
    if (ms < 1000) return `${Math.round(ms)}ms`
    return `${(ms / 1000).toFixed(1)}s`
}

// ─── Row Component ────────────────────────────────────────────────────────────

const LogRow = ({ log }: { log: LogEntry }) => {
    const [expanded, setExpanded] = useState(false)
    const icon = OPERATION_ICONS[log.operation] ?? "⚙️"
    const label = OPERATION_LABELS[log.operation] ?? log.operation
    const color = STATUS_COLORS[log.status] ?? "grey"

    return (
        <div
            className={`border-b border-ui-border-base last:border-0 transition-colors ${log.status === 'failed' ? 'bg-red-50/5' : ''
                }`}
        >
            {/* Main row — always visible */}
            <div
                className="flex items-center gap-3 px-4 py-2.5 cursor-pointer hover:bg-ui-bg-subtle/50"
                onClick={() => setExpanded(p => !p)}
            >
                {/* Icon + operation */}
                <span className="text-base shrink-0">{icon}</span>
                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                        <Text className="text-xs font-semibold">{label}</Text>
                        {log.order_display_id && (
                            <Text className="text-xs text-ui-fg-subtle">Order #{log.order_display_id}</Text>
                        )}
                        {log.qb_ref_number && (
                            <Text className="text-xs text-ui-fg-muted font-mono">QB #{log.qb_ref_number}</Text>
                        )}
                        {log.triggered_by === 'manual' && (
                            <Badge size="xsmall" color="blue">Manual</Badge>
                        )}
                    </div>
                    {log.message && (
                        <Text className="text-xs text-ui-fg-subtle">{log.message}</Text>
                    )}
                    {/* Show truncated error inline for failed entries */}
                    {log.status === 'failed' && log.error && (
                        <Text className="text-xs text-red-500 font-mono truncate max-w-[36rem]" title={log.error}>
                            ⚠ {log.error.length > 120 ? log.error.slice(0, 120) + '…' : log.error}
                        </Text>
                    )}
                </div>

                {/* Right side: duration | status | server | date | arrow */}
                <div className="flex items-center gap-3 shrink-0 text-right">
                    {log.duration_ms !== null && (
                        <Text className="text-xs text-ui-fg-muted hidden sm:block">{formatDuration(log.duration_ms)}</Text>
                    )}
                    <Badge color={color} size="xsmall">{STATUS_LABELS[log.status]}</Badge>
                    {log.server_host && (
                        <Text
                            className="text-xs font-mono hidden lg:block w-28 text-right"
                            style={{ color: log.server_host.startsWith('Railway') ? '#f97316' : '#94a3b8' }}
                        >
                            {log.server_host.startsWith('Railway') ? '⚡ Railway' : `💻 ${log.server_host.substring(0, 12)}`}
                        </Text>
                    )}
                    <Text className="text-xs text-ui-fg-muted hidden md:block w-36">{formatDate(log.initiated_at)}</Text>
                    <span className="text-ui-fg-muted text-xs">{expanded ? '▲' : '▼'}</span>
                </div>
            </div>

            {/* Expanded detail */}
            {expanded && (
                <div className="px-10 pb-3 pt-1 space-y-1 bg-ui-bg-subtle/30 border-t border-ui-border-base/50">
                    <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs">
                        {log.event_type && (
                            <><Text className="text-ui-fg-muted">Event</Text><Text className="font-mono">{log.event_type}</Text></>
                        )}
                        {log.qb_txn_id && (
                            <><Text className="text-ui-fg-muted">QB TxnID</Text><Text className="font-mono">{log.qb_txn_id}</Text></>
                        )}
                        {log.qb_ref_number && (
                            <><Text className="text-ui-fg-muted">QB Ref#</Text><Text className="font-mono">{log.qb_ref_number}</Text></>
                        )}
                        {log.order_id && (
                            <><Text className="text-ui-fg-muted">Order ID</Text><Text className="font-mono text-xs break-all">{log.order_id}</Text></>
                        )}
                        {log.completed_at && (
                            <><Text className="text-ui-fg-muted">Completed</Text><Text>{formatDate(log.completed_at)}</Text></>
                        )}
                        {log.duration_ms !== null && (
                            <><Text className="text-ui-fg-muted">Duration</Text><Text>{formatDuration(log.duration_ms)}</Text></>
                        )}
                    </div>
                    {/* Inventory sync changed items */}
                    {log.operation === 'inventory_sync' && log.metadata?.changedItems && log.metadata.changedItems.length > 0 && (
                        <div className="mt-3">
                            <Text className="text-xs font-semibold text-ui-fg-muted mb-1.5 block">
                                Changed Items ({log.metadata.changedItems.length})
                            </Text>
                            <div className="rounded-md border border-ui-border-base overflow-hidden">
                                <table className="w-full text-xs">
                                    <thead>
                                        <tr className="bg-ui-bg-subtle border-b border-ui-border-base">
                                            <th className="text-left px-3 py-1.5 text-ui-fg-muted font-medium">SKU</th>
                                            <th className="text-right px-3 py-1.5 text-ui-fg-muted font-medium">Before</th>
                                            <th className="text-right px-3 py-1.5 text-ui-fg-muted font-medium">After</th>
                                            <th className="text-right px-3 py-1.5 text-ui-fg-muted font-medium">Δ</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {log.metadata.changedItems.map((item: ChangedItem) => (
                                            <tr key={item.sku} className="border-b border-ui-border-base/50 last:border-0 hover:bg-ui-bg-subtle/50">
                                                <td className="px-3 py-1.5">
                                                    <span className="font-mono">{item.sku}</span>
                                                    {item.anomaly && <span className="ml-1.5 text-orange-400" title="Anomaly detected">⚠️</span>}
                                                </td>
                                                <td className="px-3 py-1.5 text-right text-ui-fg-subtle">{item.prev}</td>
                                                <td className="px-3 py-1.5 text-right font-medium">{item.next}</td>
                                                <td className={`px-3 py-1.5 text-right font-mono font-semibold ${item.delta > 0 ? 'text-green-500' : item.delta < 0 ? 'text-red-400' : 'text-ui-fg-muted'
                                                    }`}>
                                                    {item.delta > 0 ? '+' : ''}{item.delta}
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    )}
                    {log.error && (
                        <div className="mt-2 p-2 rounded bg-red-50 border border-red-200">
                            <Text className="text-xs text-red-700 font-mono">{log.error}</Text>
                        </div>
                    )}
                </div>
            )}
        </div>
    )
}

// ─── Clear Log Button ─────────────────────────────────────────────────────────

function ClearLogButton({ onDone }: { onDone: () => void }) {
    const [showModal, setShowModal] = useState(false)
    const [input, setInput]         = useState("")
    const [loading, setLoading]     = useState(false)

    const handleClear = async () => {
        if (input.trim() !== "CONFIRM") return
        setLoading(true)
        try {
            await fetch("/admin/quickbooks/logs", { method: "DELETE", credentials: "include" })
            onDone()
        } catch { /* non-blocking */ } finally {
            setLoading(false)
            setShowModal(false)
            setInput("")
        }
    }

    return (
        <>
            <button
                onClick={() => { setInput(""); setShowModal(true) }}
                className="px-2 py-1 rounded text-[11px] font-semibold border transition-colors bg-red-600 hover:bg-red-700 text-white border-red-700"
            >
                Clear Log
            </button>

            {showModal && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
                    <div className="bg-ui-bg-base rounded-lg shadow-xl border border-ui-border-base p-5 w-80">
                        <p className="text-sm font-semibold text-ui-fg-base mb-1">Clear Activity Log</p>
                        <p className="text-xs text-ui-fg-subtle mb-4">
                            This will permanently delete all entries from the QB sync log. This action cannot be undone.
                        </p>
                        <p className="text-xs text-ui-fg-muted mb-1">
                            Type <span className="font-mono font-bold text-red-600">CONFIRM</span> to proceed:
                        </p>
                        <input
                            autoFocus
                            value={input}
                            onChange={e => setInput(e.target.value)}
                            onKeyDown={e => { if (e.key === "Enter") handleClear() }}
                            className="w-full border border-ui-border-base rounded px-2 py-1 text-xs font-mono mb-3 bg-ui-bg-field text-ui-fg-base focus:outline-none focus:ring-1 focus:ring-red-500"
                            placeholder="CONFIRM"
                        />
                        <div className="flex gap-2 justify-end">
                            <button
                                onClick={() => { setShowModal(false); setInput("") }}
                                className="px-3 py-1 rounded text-xs border border-ui-border-base text-ui-fg-base hover:bg-ui-bg-subtle"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={handleClear}
                                disabled={input.trim() !== "CONFIRM" || loading}
                                className="px-3 py-1 rounded text-xs font-semibold bg-red-600 hover:bg-red-700 text-white disabled:opacity-40"
                            >
                                {loading ? "Clearing…" : "Clear"}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </>
    )
}

// ─── Main Component ───────────────────────────────────────────────────────────

type ActivityLogProps = {
    autoRefresh?: boolean
}

export const ActivityLog = ({ autoRefresh = false }: ActivityLogProps) => {
    const [logs, setLogs] = useState<LogEntry[]>([])
    const [total, setTotal] = useState(0)
    const [loading, setLoading] = useState(false)
    const [page, setPage] = useState(0)
    const [status, setStatus] = useState<string>("all")
    const LIMIT = 12

    const fetchLogs = useCallback(async (pg = page, st = status) => {
        setLoading(true)
        try {
            const params = new URLSearchParams({
                limit: String(LIMIT),
                offset: String(pg * LIMIT),
            })
            if (st !== 'all') params.set('status', st)

            const res = await fetch(`/admin/quickbooks/logs?${params}`, { credentials: 'include' })
            if (!res.ok) return
            const data = await res.json()
            setLogs(data.logs)
            setTotal(data.pagination.total)
        } catch { /* non-blocking */ }
        finally { setLoading(false) }
    }, [page, status])

    useEffect(() => { fetchLogs() }, [fetchLogs])

    // Auto-refresh every 15s if enabled
    useEffect(() => {
        if (!autoRefresh) return
        const interval = setInterval(() => fetchLogs(), 15_000)
        return () => clearInterval(interval)
    }, [autoRefresh, fetchLogs])

    const handleStatus = (val: string) => { setStatus(val); setPage(0); fetchLogs(0, val) }

    const totalPages = Math.ceil(total / LIMIT)

    return (
        <Container>
            <div className="p-4 space-y-3">
                {/* Header */}
                <div className="flex items-center justify-between">
                    <div>
                        <Heading level="h3" className="text-sm font-medium">📋 Activity Log</Heading>
                        <Text className="text-xs text-ui-fg-subtle mt-0.5">
                            Background sync operations — Inventory, Price, Customer &amp; POS sync
                        </Text>
                    </div>
                    <div className="flex items-center gap-2">
                        <ClearLogButton onDone={() => { setPage(0); fetchLogs(0, status) }} />
                        <Button
                            variant="secondary"
                            size="small"
                            onClick={() => fetchLogs()}
                            isLoading={loading}
                        >
                            <ArrowPath className="w-3 h-3 mr-1" /> Refresh
                        </Button>
                    </div>
                </div>

                {/* Filters */}
                <div className="flex gap-2 items-center">
                    <div className="w-36">
                        <Select value={status} onValueChange={handleStatus}>
                            <Select.Trigger><Select.Value /></Select.Trigger>
                            <Select.Content>
                                <Select.Item value="all">All Statuses</Select.Item>
                                <Select.Item value="completed">Completed</Select.Item>
                                <Select.Item value="processing">Processing</Select.Item>
                                <Select.Item value="failed">Failed</Select.Item>
                                <Select.Item value="skipped">Skipped</Select.Item>
                            </Select.Content>
                        </Select>
                    </div>
                    <Text className="text-xs text-ui-fg-muted ml-auto">
                        {total} total entries
                    </Text>
                </div>

                {/* Log rows */}
                <div className="rounded-lg border border-ui-border-base overflow-hidden">
                    {loading && logs.length === 0 && (
                        <div className="flex items-center justify-center h-24">
                            <Text className="text-xs text-ui-fg-subtle animate-pulse">Loading...</Text>
                        </div>
                    )}
                    {!loading && logs.length === 0 && (
                        <div className="flex flex-col items-center justify-center h-24 gap-1">
                            <Text className="text-xs text-ui-fg-subtle">No activity recorded yet</Text>
                            <Text className="text-xs text-ui-fg-muted">Order events and syncs will appear here</Text>
                        </div>
                    )}
                    {logs.map((log) => <LogRow key={log.id} log={log} />)}
                </div>

                {/* Pagination */}
                {totalPages > 1 && (
                    <div className="flex items-center justify-between pt-1">
                        <Button
                            variant="secondary" size="small"
                            onClick={() => { const p = page - 1; setPage(p); fetchLogs(p, status) }}
                            disabled={page === 0 || loading}
                        >← Prev</Button>
                        <Text className="text-xs text-ui-fg-muted">
                            Page {page + 1} of {totalPages}
                        </Text>
                        <Button
                            variant="secondary" size="small"
                            onClick={() => { const p = page + 1; setPage(p); fetchLogs(p, status) }}
                            disabled={page >= totalPages - 1 || loading}
                        >Next →</Button>
                    </div>
                )}
            </div>
        </Container>
    )
}

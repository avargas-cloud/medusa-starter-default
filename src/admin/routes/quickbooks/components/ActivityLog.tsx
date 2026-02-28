import { useEffect, useState, useCallback } from "react"
import { Container, Heading, Text, Button, Badge, Select } from "@medusajs/ui"
import { ArrowPath } from "@medusajs/icons"

// ─── Types ────────────────────────────────────────────────────────────────────

type LogStatus = "processing" | "completed" | "failed" | "skipped"
type LogCategory = "all" | "order" | "sync"

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
                        <Text className="text-xs text-ui-fg-subtle truncate">{log.message}</Text>
                    )}
                </div>

                {/* Right side: status + duration + time */}
                <div className="flex items-center gap-3 shrink-0 text-right">
                    {log.duration_ms !== null && (
                        <Text className="text-xs text-ui-fg-muted hidden sm:block">{formatDuration(log.duration_ms)}</Text>
                    )}
                    <Badge color={color} size="xsmall">{STATUS_LABELS[log.status]}</Badge>
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

// ─── Main Component ───────────────────────────────────────────────────────────

type ActivityLogProps = {
    autoRefresh?: boolean
}

export const ActivityLog = ({ autoRefresh = false }: ActivityLogProps) => {
    const [logs, setLogs] = useState<LogEntry[]>([])
    const [total, setTotal] = useState(0)
    const [loading, setLoading] = useState(false)
    const [page, setPage] = useState(0)
    const [category, setCategory] = useState<LogCategory>("all")
    const [status, setStatus] = useState<string>("all")
    const LIMIT = 25

    const fetchLogs = useCallback(async (pg = page, cat = category, st = status) => {
        setLoading(true)
        try {
            const params = new URLSearchParams({
                limit: String(LIMIT),
                offset: String(pg * LIMIT),
            })
            if (cat !== 'all') params.set('category', cat)
            if (st !== 'all') params.set('status', st)

            const res = await fetch(`/admin/quickbooks/logs?${params}`, { credentials: 'include' })
            if (!res.ok) return
            const data = await res.json()
            setLogs(data.logs)
            setTotal(data.pagination.total)
        } catch { /* non-blocking */ }
        finally { setLoading(false) }
    }, [page, category, status])

    useEffect(() => { fetchLogs() }, [fetchLogs])

    // Auto-refresh every 15s if enabled
    useEffect(() => {
        if (!autoRefresh) return
        const interval = setInterval(() => fetchLogs(), 15_000)
        return () => clearInterval(interval)
    }, [autoRefresh, fetchLogs])

    const handleCategory = (val: string) => { setCategory(val as LogCategory); setPage(0); fetchLogs(0, val as LogCategory, status) }
    const handleStatus = (val: string) => { setStatus(val); setPage(0); fetchLogs(0, category, val) }

    const totalPages = Math.ceil(total / LIMIT)

    return (
        <Container>
            <div className="p-4 space-y-3">
                {/* Header */}
                <div className="flex items-center justify-between">
                    <div>
                        <Heading level="h3" className="text-sm font-medium">📋 Activity Log</Heading>
                        <Text className="text-xs text-ui-fg-subtle mt-0.5">
                            All QuickBooks operations — order events and background syncs
                        </Text>
                    </div>
                    <Button
                        variant="secondary"
                        size="small"
                        onClick={() => fetchLogs()}
                        isLoading={loading}
                    >
                        <ArrowPath className="w-3 h-3 mr-1" /> Refresh
                    </Button>
                </div>

                {/* Filters */}
                <div className="flex gap-2">
                    <div className="w-36">
                        <Select value={category} onValueChange={handleCategory}>
                            <Select.Trigger><Select.Value /></Select.Trigger>
                            <Select.Content>
                                <Select.Item value="all">All Types</Select.Item>
                                <Select.Item value="order">Order Events</Select.Item>
                                <Select.Item value="sync">Batch Syncs</Select.Item>
                            </Select.Content>
                        </Select>
                    </div>
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
                    <Text className="text-xs text-ui-fg-muted self-center ml-auto">
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
                            onClick={() => setPage(p => p - 1)}
                            disabled={page === 0 || loading}
                        >← Prev</Button>
                        <Text className="text-xs text-ui-fg-muted">
                            Page {page + 1} of {totalPages}
                        </Text>
                        <Button
                            variant="secondary" size="small"
                            onClick={() => setPage(p => p + 1)}
                            disabled={page >= totalPages - 1 || loading}
                        >Next →</Button>
                    </div>
                )}
            </div>
        </Container>
    )
}

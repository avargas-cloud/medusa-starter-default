import { Text, Badge, Button, Input, Select } from "@medusajs/ui"
import type { DraftOrderListItem, SortKey } from "../hooks/use-draft-orders"
import { SORT_OPTIONS, PAGE_SIZE } from "../hooks/use-draft-orders"

type EstimateStatus = "Created" | "Sent" | "Sent by Email" | "To be Sent" | "To Confirm Reception" | "Confirmed Reception" | "Followed Up" | "Provided in Store" | "Approved" | "Not Approved" | "Cancelled" | "Duplicate" | "Placed Online"

const STATUS_BADGE_COLOR: Record<EstimateStatus, "grey" | "blue" | "purple" | "orange" | "green" | "red"> = {
    "Created": "grey",
    "Sent": "blue",
    "Sent by Email": "blue",
    "To be Sent": "orange",
    "To Confirm Reception": "purple",
    "Confirmed Reception": "purple",
    "Followed Up": "orange",
    "Provided in Store": "green",
    "Approved": "green",
    "Not Approved": "red",
    "Cancelled": "red",
    "Duplicate": "grey",
    "Placed Online": "blue",
}

const formatDate = (d: string) => new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })

const formatCurrency = (amount?: number, currency?: string) => {
    if (amount == null) return "—"
    return new Intl.NumberFormat("en-US", { style: "currency", currency: (currency || "USD").toUpperCase(), minimumFractionDigits: 2 }).format(amount)
}

const COLS = "grid-cols-[80px_110px_100px_minmax(110px,1fr)_minmax(110px,1fr)_minmax(170px,1.3fr)_120px_130px_80px_88px]"
const HEADERS = ["Ref Num", "QB Ref #", "Date", "Company", "Customer", "Email", "Sales Channel", "Status", "QB Synced", "Total"]

interface DraftOrdersTableProps {
    loading: boolean
    sorted: DraftOrderListItem[]
    paginated: DraftOrderListItem[]
    onRowClick: (id: string) => void
    rowHref?: (id: string) => string
}

export const DraftOrdersTable = ({ loading, sorted, paginated, onRowClick, rowHref }: DraftOrdersTableProps) => {
    if (loading) return <div className="p-6"><Text size="small" className="text-ui-fg-muted">Loading draft orders...</Text></div>
    if (sorted.length === 0) return <div className="p-6"><Text size="small" className="text-ui-fg-subtle">No draft orders found.</Text></div>

    return (
        <div className="min-w-[900px]">
            {/* Column headers */}
            <div className={`grid ${COLS} gap-x-3 px-4 py-2 bg-ui-bg-subtle border-b border-ui-border-base`}>
                {HEADERS.map((h, i) => (
                    <Text key={i} size="xsmall" weight="plus" className={`text-ui-fg-muted uppercase tracking-wider ${i === 9 ? "text-right" : ""}`}>{h}</Text>
                ))}
            </div>
            {/* Rows */}
            {paginated.map(order => {
                const name = order.customer ? `${order.customer.first_name ?? ""} ${order.customer.last_name ?? ""}`.trim() || "—" : "—"
                const email = order.customer?.email ?? order.email ?? "—"
                const synced = !!order.metadata?.qb_estimate_txn_id
                const qbRef = (order.metadata?.qb_estimate_ref as string | null) ?? null
                const s = (order.metadata?.order_status ?? order.metadata?.estimate_status) as EstimateStatus | undefined

                const isDeclined = s === "Not Approved"
                const isCancelled = s === "Cancelled"
                return (
                    <div key={order.id}
                        className={`grid ${COLS} gap-x-3 px-4 py-3 border-b border-ui-border-base hover:bg-ui-bg-subtle-hover transition-colors cursor-pointer items-center${(isDeclined || isCancelled) ? " opacity-50" : ""}`}
                        onClick={() => onRowClick(order.id)}
                        onMouseDown={e => { if (e.button === 1) e.preventDefault() }}
                        onAuxClick={e => { if (e.button === 1 && rowHref) window.open(rowHref(order.id), '_blank') }}>
                        <Text size="small" weight="plus">{order.display_id}</Text>
                        <Text size="small" className="font-mono text-ui-fg-subtle truncate">{qbRef ?? "—"}</Text>
                        <Text size="small" className="text-ui-fg-subtle">{formatDate(order.created_at)}</Text>
                        <Text size="small" className="line-clamp-2 text-ui-fg-subtle leading-tight">{order.customer?.company_name ?? "—"}</Text>
                        <Text size="small" className="truncate">{name}</Text>
                        <Text size="small" className="text-ui-fg-subtle break-all">{email}</Text>
                        <Text size="small" className="text-ui-fg-subtle truncate">
                            {(order.sales_channel?.name === "Default Sales Channel" || !order.sales_channel?.name) ? "Default" : order.sales_channel.name}
                        </Text>
                        <div>
                            <Badge color={s ? STATUS_BADGE_COLOR[s] ?? "grey" : "grey"} size="small">{s ?? "—"}</Badge>
                        </div>
                        <div className="flex justify-center">
                            <Badge color={synced ? "green" : "orange"} size="small">{synced ? "✓ Yes" : "Pending"}</Badge>
                        </div>
                        <Text size="small" className="text-right">{formatCurrency(
                            // Priority: metadata.computed_total (explicitly saved by compute-tax: items - discounts + taxes + shipping)
                            // Fallback: order.total (may be pre-tax in dev, or shipping-only in prod if patches not applied)
                            order.metadata?.computed_total != null
                                ? Number(order.metadata.computed_total)
                                : order.total != null
                                    ? Number(order.total)
                                    : undefined,
                            order.currency_code
                        )}</Text>
                    </div>
                )
            })}
        </div>
    )
}

interface DraftOrdersHeaderProps {
    search: string; onSearchChange: (v: string) => void
    sort: SortKey; onSortChange: (v: SortKey) => void
    showNotApproved: boolean; onToggleNotApproved: () => void; notApprovedCount: number
    showCancelled: boolean; onToggleCancelled: () => void; cancelledCount: number
}

export const DraftOrdersControls = ({
    search, onSearchChange, sort, onSortChange,
    showNotApproved, onToggleNotApproved, notApprovedCount,
    showCancelled, onToggleCancelled, cancelledCount,
}: DraftOrdersHeaderProps) => (
    <div className="flex items-center gap-3 flex-wrap px-4 py-3">
        <Input placeholder="Search by #, customer or email..." value={search} onChange={e => onSearchChange(e.target.value)} className="max-w-sm" />
        {/* Show Declined toggle */}
        <Button
            variant={showNotApproved ? "primary" : "secondary"}
            size="small"
            onClick={onToggleNotApproved}
        >
            {showNotApproved ? "Hide Declined" : `Show Declined${notApprovedCount ? ` (${notApprovedCount})` : ""}`}
        </Button>
        {/* Show Cancelled toggle */}
        <Button
            variant={showCancelled ? "primary" : "secondary"}
            size="small"
            onClick={onToggleCancelled}
        >
            {showCancelled ? "Hide Cancelled" : `Show Cancelled${cancelledCount ? ` (${cancelledCount})` : ""}`}
        </Button>
        <div className="flex items-center gap-2 ml-auto">
            <Text size="small" className="text-ui-fg-subtle whitespace-nowrap">Sort by:</Text>
            <Select value={sort} onValueChange={v => onSortChange(v as SortKey)}>
                <Select.Trigger className="w-52"><Select.Value /></Select.Trigger>
                <Select.Content>{SORT_OPTIONS.map(o => <Select.Item key={o.value} value={o.value}>{o.label}</Select.Item>)}</Select.Content>
            </Select>
        </div>
    </div>
)

interface DraftOrdersFooterProps {
    loading: boolean; sorted: DraftOrderListItem[]; page: number; totalPages: number
    onPrev: () => void; onNext: () => void
}

export const DraftOrdersFooter = ({ loading, sorted, page, totalPages, onPrev, onNext }: DraftOrdersFooterProps) => (
    <div className="flex items-center justify-between px-4 py-3">
        <Text size="xsmall" className="text-ui-fg-muted">
            {!loading && `${sorted.length} draft order${sorted.length !== 1 ? "s" : ""}`}
        </Text>
        {totalPages > 1 && (
            <div className="flex items-center gap-3">
                <Text size="xsmall" className="text-ui-fg-muted">
                    {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, sorted.length)} of {sorted.length}
                </Text>
                <div className="flex gap-2">
                    <Button variant="secondary" size="small" disabled={page === 0} onClick={onPrev}>← Prev</Button>
                    <Button variant="secondary" size="small" disabled={page >= totalPages - 1} onClick={onNext}>Next →</Button>
                </div>
            </div>
        )}
    </div>
)

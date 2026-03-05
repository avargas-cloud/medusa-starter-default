import { Text, Badge, Button, Input, Select } from "@medusajs/ui"
import type { DraftOrderListItem, SortKey } from "../hooks/use-draft-orders"
import { SORT_OPTIONS, PAGE_SIZE } from "../hooks/use-draft-orders"

type EstimateStatus = "Created" | "Sent" | "Confirmed Reception" | "Followed Up" | "Approved" | "Not Approved" | "Duplicate"

const STATUS_BADGE_COLOR: Record<EstimateStatus, "grey" | "blue" | "purple" | "orange" | "green" | "red"> = {
    "Created": "grey", "Sent": "blue", "Confirmed Reception": "purple",
    "Followed Up": "orange", "Approved": "green", "Not Approved": "red", "Duplicate": "grey",
}

const formatDate = (d: string) => new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })

const formatCurrency = (amount?: number, currency?: string) => {
    if (amount == null) return "—"
    return new Intl.NumberFormat("en-US", { style: "currency", currency: (currency || "USD").toUpperCase(), minimumFractionDigits: 2 }).format(amount)
}

const COLS = "grid-cols-[80px_100px_minmax(110px,1fr)_minmax(110px,1fr)_minmax(170px,1.3fr)_120px_130px_80px_110px_88px]"
const HEADERS = ["Ref Num", "Date", "Company", "Customer", "Email", "Sales Channel", "Status", "QB Synced", "QB Ref #", "Total"]

interface DraftOrdersTableProps {
    loading: boolean
    sorted: DraftOrderListItem[]
    paginated: DraftOrderListItem[]
    onRowClick: (id: string) => void
}

export const DraftOrdersTable = ({ loading, sorted, paginated, onRowClick }: DraftOrdersTableProps) => {
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
                const s = order.metadata?.estimate_status as EstimateStatus | undefined

                const isDeclined = s === "Not Approved"
                return (
                    <div key={order.id}
                        className={`grid ${COLS} gap-x-3 px-4 py-3 border-b border-ui-border-base hover:bg-ui-bg-subtle-hover transition-colors cursor-pointer items-center${isDeclined ? " opacity-50" : ""}`}
                        onClick={() => onRowClick(order.id)}>
                        <Text size="small" weight="plus">{order.display_id}</Text>
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
                        <Text size="small" className="font-mono text-ui-fg-subtle truncate">{qbRef ?? "—"}</Text>
                        <Text size="small" className="text-right">{formatCurrency(order.metadata?.computed_total ?? (order.total != null ? order.total / 100 : undefined), order.currency_code)}</Text>
                    </div>
                )
            })}
        </div>
    )
}

interface DraftOrdersHeaderProps {
    search: string; onSearchChange: (v: string) => void
    sort: SortKey; onSortChange: (v: SortKey) => void
    showNotApproved: boolean; onToggleNotApproved: () => void
    notApprovedCount: number
}

export const DraftOrdersControls = ({
    search, onSearchChange, sort, onSortChange,
    showNotApproved, onToggleNotApproved, notApprovedCount,
}: DraftOrdersHeaderProps) => (
    <div className="flex items-center gap-3 flex-wrap px-4 py-3">
        <Input placeholder="Search by #, customer or email..." value={search} onChange={e => onSearchChange(e.target.value)} className="max-w-sm" />
        {/* Show declined toggle */}
        <label className="flex items-center gap-1.5 cursor-pointer select-none ml-1" title="Toggle visibility of declined / not-approved estimates">
            <input
                type="checkbox"
                checked={showNotApproved}
                onChange={onToggleNotApproved}
                className="w-3.5 h-3.5 accent-ui-fg-muted rounded cursor-pointer"
            />
            <Text size="small" className="text-ui-fg-subtle whitespace-nowrap">
                Show declined
                {notApprovedCount > 0 && (
                    <span className="ml-1 inline-flex items-center justify-center px-1.5 py-0.5 rounded-full text-[10px] font-semibold bg-ui-bg-base-pressed text-ui-fg-muted">
                        {notApprovedCount}
                    </span>
                )}
            </Text>
        </label>
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

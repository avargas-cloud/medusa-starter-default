/**
 * orders-table.tsx
 * Shared table, controls, and footer for Sales Orders and Invoices pages.
 * Modeled after draft-orders-table.tsx.
 */
import { Text, Badge, Button, Input, Select } from "@medusajs/ui"
import type { OrderListItem, SortKey } from "../hooks/use-orders-list"
import { SORT_OPTIONS, PAGE_SIZE } from "../hooks/use-orders-list"

// ─── Formatting helpers ───────────────────────────────────────────────────────

const formatDate = (d: string) =>
    new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })

const formatCurrency = (amount: number, currency = "usd") =>
    new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: currency.toUpperCase(),
        minimumFractionDigits: 2,
    }).format(amount)   // Medusa v2 orders API already returns amounts in dollars

// ─── Badge helpers ────────────────────────────────────────────────────────────

const PAYMENT_COLORS: Record<string, "orange" | "green" | "red" | "grey" | "blue"> = {
    not_paid: "orange",
    awaiting: "orange",
    captured: "green",
    paid: "green",
    refunded: "blue",
    partially_refunded: "blue",
    canceled: "red",
}

const FULFILLMENT_COLORS: Record<string, "orange" | "green" | "grey" | "blue"> = {
    not_fulfilled: "orange",
    partially_fulfilled: "blue",
    fulfilled: "green",
}

const prettyLabel = (s: string) =>
    s.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase())

// ─── Column layout ────────────────────────────────────────────────────────────

const COLS = "grid-cols-[80px_110px_110px_minmax(120px,1fr)_minmax(120px,1fr)_120px_120px_110px_110px]"
const HEADERS = ["Order #", "QB Ref #", "Date", "Company", "Customer", "Payment", "Fulfillment", "Channel", "Total"]

// ─── Table ────────────────────────────────────────────────────────────────────

interface OrdersTableProps {
    loading: boolean
    sorted: OrderListItem[]
    paginated: OrderListItem[]
    onRowClick: (id: string) => void
}

export const OrdersTable = ({ loading, sorted, paginated, onRowClick }: OrdersTableProps) => {
    if (loading) return <div className="p-6"><Text size="small" className="text-ui-fg-muted">Loading orders...</Text></div>
    if (sorted.length === 0) return <div className="p-6"><Text size="small" className="text-ui-fg-subtle">No orders found.</Text></div>

    return (
        <div className="min-w-[900px]">
            {/* Column headers */}
            <div className={`grid ${COLS} gap-x-3 px-4 py-2 bg-ui-bg-subtle border-b border-ui-border-base`}>
                {HEADERS.map((h, i) => (
                    <Text key={i} size="xsmall" weight="plus"
                        className={`text-ui-fg-muted uppercase tracking-wider ${i === 8 ? "text-right" : ""}`}>
                        {h}
                    </Text>
                ))}
            </div>
            {/* Rows */}
            {paginated.map(order => {
                const firstName = order.customer?.first_name ?? order.shipping_address?.first_name ?? ""
                const lastName = order.customer?.last_name ?? order.shipping_address?.last_name ?? ""
                const customerName = [firstName, lastName].filter(Boolean).join(" ") || order.customer?.email || "—"
                const company = order.customer?.company_name ?? order.shipping_address?.company ?? "—"
                const channel = (order.sales_channel?.name === "Default Sales Channel" || !order.sales_channel?.name)
                    ? "Default" : order.sales_channel.name!

                const qbRef = (order.metadata?.qb_sales_order_ref ?? order.metadata?.qb_invoice_ref ?? null) as string | null
                return (
                    <div key={order.id}
                        className={`grid ${COLS} gap-x-3 px-4 py-3 border-b border-ui-border-base hover:bg-ui-bg-subtle-hover transition-colors cursor-pointer items-center`}
                        onClick={() => onRowClick(order.id)}>
                        <Text size="small" weight="plus">#{order.display_id}</Text>
                        <Text size="small" className="font-mono text-ui-fg-subtle truncate">{qbRef ?? "—"}</Text>
                        <Text size="small" className="text-ui-fg-subtle">{formatDate(order.created_at)}</Text>
                        <Text size="small" className="line-clamp-2 text-ui-fg-subtle leading-tight">{company}</Text>
                        <Text size="small" className="truncate">{customerName}</Text>
                        <div>
                            <Badge color={PAYMENT_COLORS[order.payment_status] ?? "grey"} size="small">
                                {prettyLabel(order.payment_status)}
                            </Badge>
                        </div>
                        <div>
                            <Badge color={FULFILLMENT_COLORS[order.fulfillment_status] ?? "grey"} size="small">
                                {prettyLabel(order.fulfillment_status)}
                            </Badge>
                        </div>
                        <Text size="small" className="text-ui-fg-subtle truncate">{channel}</Text>
                        <Text size="small" className="text-right font-medium">
                            {formatCurrency(order.total, order.currency_code)}
                        </Text>
                    </div>
                )
            })}
        </div>
    )
}

// ─── Controls (search + sort bar) ───────────────────────────────────────────

interface OrdersControlsProps {
    search: string
    onSearchChange: (v: string) => void
    sort: SortKey
    onSortChange: (v: SortKey) => void
    searchPlaceholder?: string
    showCancelled?: boolean
    onToggleCancelled?: () => void
    cancelledCount?: number
}

export const OrdersControls = ({
    search, onSearchChange, sort, onSortChange,
    searchPlaceholder = "Search by #, customer, company or email...",
    showCancelled, onToggleCancelled, cancelledCount,
}: OrdersControlsProps) => (
    <div className="flex items-center gap-3 flex-wrap px-4 py-3">
        <Input
            placeholder={searchPlaceholder}
            value={search}
            onChange={e => onSearchChange(e.target.value)}
            className="max-w-sm"
        />
        {onToggleCancelled && (
            <Button
                variant={showCancelled ? "primary" : "secondary"}
                size="small"
                onClick={onToggleCancelled}
            >
                {showCancelled ? "Hide Cancelled" : `Show Cancelled${cancelledCount ? ` (${cancelledCount})` : ""}`}
            </Button>
        )}
        <div className="flex items-center gap-2 ml-auto">
            <Text size="small" className="text-ui-fg-subtle whitespace-nowrap">Sort by:</Text>
            <Select value={sort} onValueChange={v => onSortChange(v as SortKey)}>
                <Select.Trigger className="w-52"><Select.Value /></Select.Trigger>
                <Select.Content>
                    {SORT_OPTIONS.map(o => (
                        <Select.Item key={o.value} value={o.value}>{o.label}</Select.Item>
                    ))}
                </Select.Content>
            </Select>
        </div>
    </div>
)

// ─── Footer (count + pagination) ─────────────────────────────────────────────

interface OrdersFooterProps {
    loading: boolean
    sorted: OrderListItem[]
    page: number
    totalPages: number
    onPrev: () => void
    onNext: () => void
    itemLabel?: string
}

export const OrdersFooter = ({
    loading, sorted, page, totalPages, onPrev, onNext, itemLabel = "order",
}: OrdersFooterProps) => (
    <div className="flex items-center justify-between px-4 py-3">
        <Text size="xsmall" className="text-ui-fg-muted">
            {!loading && `${sorted.length} ${itemLabel}${sorted.length !== 1 ? "s" : ""}`}
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

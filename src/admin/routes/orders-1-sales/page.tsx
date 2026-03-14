import { defineRouteConfig } from "@medusajs/admin-sdk"
import { ShoppingCart } from "@medusajs/icons"
import { Container, Heading, Text, Button } from "@medusajs/ui"
import { useOrdersList } from "../sales-orders/hooks/use-orders-list"
import { OrdersTable, OrdersControls, OrdersFooter } from "../sales-orders/components/orders-table"
import { useNavigate } from "react-router-dom"

// ─── Sidebar config ───────────────────────────────────────────────────────────
// orders-1-sales sorts after draft-orders-advanced (d) → "Sales Orders" appears 2nd
export const config = defineRouteConfig({
    label: "Sales Orders",
    icon: ShoppingCart,
    nested: "/orders",
})

// ─── Page ─────────────────────────────────────────────────────────────────────
const SalesOrdersPage = () => {
    const {
        navigate, loading, sorted, paginated, totalPages,
        search, setSearch, sort, setSort, page, setPage,
        showCancelled, setShowCancelled, cancelledCount,
    } = useOrdersList(["not_fulfilled", "partially_fulfilled"])
    const nav = useNavigate()

    const handleSearchChange = (v: string) => { setSearch(v); setPage(0) }
    const handleSortChange = (v: Parameters<typeof setSort>[0]) => { setSort(v); setPage(0) }

    return (
        <div className="flex flex-col gap-4 p-6">
            <div className="flex items-center justify-between">
                <div>
                    <Heading level="h1">Sales Orders</Heading>
                    <Text className="text-ui-fg-subtle text-sm mt-1">
                        Confirmed orders pending or partially fulfilled.
                        {!loading && <span className="ml-1 text-ui-fg-muted">({sorted.length})</span>}
                    </Text>
                </div>
                <Button size="small" onClick={() => nav("/orders/create")}>
                    + Create Sales Order
                </Button>
            </div>
            <Container className="divide-y p-0 overflow-hidden">
                <OrdersControls
                    search={search} onSearchChange={handleSearchChange}
                    sort={sort} onSortChange={handleSortChange}
                    showCancelled={showCancelled}
                    onToggleCancelled={() => { setShowCancelled(v => !v); setPage(0) }}
                    cancelledCount={cancelledCount}
                />
                <div className="overflow-x-auto">
                    <OrdersTable
                        loading={loading} sorted={sorted} paginated={paginated}
                        onRowClick={id => navigate(`/orders/${id}`)}
                        rowHref={id => `/app/orders/${id}`}
                    />
                </div>
                <OrdersFooter
                    loading={loading} sorted={sorted}
                    page={page} totalPages={totalPages}
                    onPrev={() => setPage(p => p - 1)}
                    onNext={() => setPage(p => p + 1)}
                    itemLabel="sales order"
                />
            </Container>
        </div>
    )
}

export default SalesOrdersPage

import { Container, Heading, Text, Button } from "@medusajs/ui"
import { useOrdersList } from "./hooks/use-orders-list"
import { OrdersTable, OrdersControls, OrdersFooter } from "./components/orders-table"

// NOTE: Sidebar config moved to orders-1-sales/page.tsx for correct sidebar ordering

// ─── Page ─────────────────────────────────────────────────────────────────────
//
// Sales Orders = confirmed orders that are NOT yet fully fulfilled.
// Includes: not_fulfilled + partially_fulfilled
// Does NOT include: fulfilled (those go to Invoices)
//
const SalesOrdersPage = () => {
    const {
        navigate, loading, sorted, paginated, totalPages,
        search, setSearch, sort, setSort, page, setPage,
    } = useOrdersList(["not_fulfilled", "partially_fulfilled"])

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
                {/* Navigate to native order creation in Medusa */}
                <Button size="small" onClick={() => navigate("/orders/create")}>
                    + Create Sales Order
                </Button>
            </div>
            <Container className="divide-y p-0 overflow-hidden">
                <OrdersControls
                    search={search} onSearchChange={handleSearchChange}
                    sort={sort} onSortChange={handleSortChange}
                />
                <div className="overflow-x-auto">
                    <OrdersTable
                        loading={loading} sorted={sorted} paginated={paginated}
                        onRowClick={id => navigate(`/orders/${id}`)}
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

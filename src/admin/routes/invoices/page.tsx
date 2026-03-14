import { Container, Heading, Text } from "@medusajs/ui"
// Reuse the shared hook and components from sales-orders
import { useOrdersList } from "../sales-orders/hooks/use-orders-list"
import { OrdersTable, OrdersControls, OrdersFooter } from "../sales-orders/components/orders-table"

// NOTE: Sidebar config moved to orders-2-invoices/page.tsx for correct sidebar ordering

// ─── Page ─────────────────────────────────────────────────────────────────────
//
// Invoices = orders that have been fully fulfilled.
// NOTE: Partially fulfilled orders remain in Sales Orders, not here.
//
const InvoicesPage = () => {
    const {
        navigate, loading, sorted, paginated, totalPages,
        search, setSearch, sort, setSort, page, setPage,
    } = useOrdersList(["fulfilled"])

    const handleSearchChange = (v: string) => { setSearch(v); setPage(0) }
    const handleSortChange = (v: Parameters<typeof setSort>[0]) => { setSort(v); setPage(0) }

    return (
        <div className="flex flex-col gap-4 p-6">
            <div className="flex items-center justify-between">
                <div>
                    <Heading level="h1">Invoices</Heading>
                    <Text className="text-ui-fg-subtle text-sm mt-1">
                        Fully fulfilled orders.
                        {!loading && <span className="ml-1 text-ui-fg-muted">({sorted.length})</span>}
                    </Text>
                </div>
                {/* No create button — Invoices are read-mostly */}
            </div>
            <Container className="divide-y p-0 overflow-hidden">
                <OrdersControls
                    search={search} onSearchChange={handleSearchChange}
                    sort={sort} onSortChange={handleSortChange}
                    searchPlaceholder="Search by #, customer, company or email..."
                />
                <div className="overflow-x-auto">
                    <OrdersTable
                        loading={loading} sorted={sorted} paginated={paginated}
                        onRowClick={id => navigate(`/orders/${id}`)}
                        rowHref={id => `/orders/${id}`}
                    />
                </div>
                <OrdersFooter
                    loading={loading} sorted={sorted}
                    page={page} totalPages={totalPages}
                    onPrev={() => setPage(p => p - 1)}
                    onNext={() => setPage(p => p + 1)}
                    itemLabel="invoice"
                />
            </Container>
        </div>
    )
}

export default InvoicesPage

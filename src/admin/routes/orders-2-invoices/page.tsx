import { defineRouteConfig } from "@medusajs/admin-sdk"
import { DocumentText } from "@medusajs/icons"
import { Container, Heading, Text } from "@medusajs/ui"
import { useOrdersList } from "../sales-orders/hooks/use-orders-list"
import { OrdersTable, OrdersControls, OrdersFooter } from "../sales-orders/components/orders-table"

// ─── Sidebar config ───────────────────────────────────────────────────────────
// orders-2-invoices sorts after orders-1-sales → "Invoices" appears 3rd
export const config = defineRouteConfig({
    label: "Invoices",
    icon: DocumentText,
    nested: "/orders",
})

// ─── Page ─────────────────────────────────────────────────────────────────────
// Invoices = fully fulfilled ("fulfilled") OR delivered ("delivered")
const InvoicesPage = () => {
    const {
        navigate, loading, sorted, paginated, totalPages,
        search, setSearch, sort, setSort, page, setPage,
    } = useOrdersList(["fulfilled", "delivered"])

    const handleSearchChange = (v: string) => { setSearch(v); setPage(0) }
    const handleSortChange = (v: Parameters<typeof setSort>[0]) => { setSort(v); setPage(0) }

    return (
        <div className="flex flex-col gap-4 p-6">
            <div className="flex items-center justify-between">
                <div>
                    <Heading level="h1">Invoices</Heading>
                    <Text className="text-ui-fg-subtle text-sm mt-1">
                        Fully fulfilled and delivered orders.
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

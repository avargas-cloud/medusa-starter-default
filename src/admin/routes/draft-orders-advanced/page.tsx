import { useState } from "react"
import { Container, Heading, Text, Button } from "@medusajs/ui"
import { useDraftOrders } from "./hooks/use-draft-orders"
import { DraftOrdersTable, DraftOrdersControls, DraftOrdersFooter } from "./components/draft-orders-table"
import { CreateDraftOrderModal } from "./components/CreateDraftOrderModal"
import { useNavigate } from "react-router-dom"

// ─── List Page ───────────────────────────────────────────────────────────────
const DraftOrdersAdvancedList = () => {
    const {
        navigate, loading, sorted, paginated, totalPages,
        search, setSearch, sort, setSort, page, setPage,
    } = useDraftOrders()
    const nav = useNavigate()
    const [showCreate, setShowCreate] = useState(false)

    const handleSearchChange = (v: string) => { setSearch(v); setPage(0) }
    const handleSortChange = (v: Parameters<typeof setSort>[0]) => { setSort(v); setPage(0) }

    return (
        <div className="flex flex-col gap-4 p-6">
            {showCreate && (
                <CreateDraftOrderModal
                    onClose={() => setShowCreate(false)}
                    onCreated={id => { setShowCreate(false); nav(`/draft-orders-advanced/${id}`) }}
                />
            )}
            <div className="flex items-center justify-between">
                <div>
                    <Heading level="h1">Draft Orders | Estimates</Heading>
                    <Text className="text-ui-fg-subtle text-sm mt-1">Manage draft orders and sync them to QuickBooks as Estimates.</Text>
                </div>
                <Button size="small" onClick={() => setShowCreate(true)}>+ New Draft Order</Button>
            </div>
            <Container className="divide-y p-0 overflow-hidden">
                <DraftOrdersControls search={search} onSearchChange={handleSearchChange} sort={sort} onSortChange={handleSortChange} />
                <div className="overflow-x-auto">
                    <DraftOrdersTable loading={loading} sorted={sorted} paginated={paginated} onRowClick={id => navigate(`/draft-orders-advanced/${id}`)} />
                </div>
                <DraftOrdersFooter loading={loading} sorted={sorted} page={page} totalPages={totalPages} onPrev={() => setPage(p => p - 1)} onNext={() => setPage(p => p + 1)} />
            </Container>
        </div>
    )
}

export default DraftOrdersAdvancedList

import { Container, Heading, Badge, Text } from "@medusajs/ui"
import { ArrowUpRightOnBox } from "@medusajs/icons"
import { useParams, useNavigate } from "react-router-dom"
import { useState } from "react"
import { useDraftOrderDetail } from "./hooks/use-draft-order-detail"
import { useOrderPageState } from "./hooks/use-order-page-state"
import { OrderDrawers } from "./components/OrderDrawers"
import { OrderHeader } from "./components/OrderHeader"
import { CustomerBlock } from "./components/CustomerBlock"
import { InlineItemsTable } from "./components/InlineItemsTable"
import { PromotionsBlock } from "./components/PromotionsBlock"
import { InlineShipping } from "./components/InlineShipping"
import { InlineTaxes } from "./components/InlineTaxes"
import { OrderTotals } from "./components/OrderTotals"
import { OrderSidebar } from "./components/OrderSidebar"
import { addrToLines } from "./helpers"

const DraftOrderDetail = () => {
    const { id } = useParams<{ id: string }>()
    const navigate = useNavigate()
    const s = useDraftOrderDetail(id)
    const { customerPrices, inlineShippingOptions, loadShippingOptions, handleAddShippingInline } =
        useOrderPageState(s.order, s.handleAddShipping)
    const [taxAmount, setTaxAmount] = useState(0)

    if (s.loading) return <div className="p-6"><Text className="text-ui-fg-muted">Loading...</Text></div>
    if (s.fetchError || !s.order) return <div className="p-6"><Text className="text-ui-fg-error">Error: {s.fetchError ?? "Not found"}</Text></div>

    const order = s.order
    const curr = order.currency_code
    const customerName = order.customer
        ? `${order.customer.first_name ?? ""} ${order.customer.last_name ?? ""}`.trim() || order.customer.email || "—"
        : order.email || "—"
    const scName = order.sales_channel?.name === "Default Sales Channel" ? "Default" : (order.sales_channel?.name ?? "Default")

    return (
        <>
            <div className="flex gap-4 p-6">

                {/* ── Left column ─────────────────────────────────────────── */}
                <div className="flex-1 flex flex-col gap-4 min-w-0">
                    <OrderHeader
                        id={id!} displayId={order.display_id} regionName={order.region?.name}
                        createdAt={order.created_at} scName={scName} converting={s.converting}
                        onNavigateBack={() => navigate("/draft-orders-advanced")}
                        onConvert={s.handleConvert} onOpenModal={s.openModal as any} onDelete={s.handleDelete}
                    />
                    <CustomerBlock
                        customer={order.customer} customerName={customerName}
                        shippingLines={addrToLines(order.shipping_address, order.customer?.company_name)}
                        billingLines={addrToLines(order.billing_address)}
                        onOpenModal={s.openModal as any}
                    />
                    <Container className="p-0 overflow-visible">
                        <div className="flex items-center justify-between px-6 py-4 border-b border-ui-border-base">
                            <div className="flex items-center gap-2">
                                <Heading level="h2">Items</Heading>
                                {order.items.length > 0 && <Badge color="grey" size="small">{order.items.length}</Badge>}
                                {s.itemSaving && <Text size="xsmall" className="text-ui-fg-muted">Saving...</Text>}
                            </div>
                            <button onClick={() => window.open(`/app/draft-orders/${id}/promotions`, "_blank")}
                                className="text-xs text-ui-fg-muted hover:text-ui-fg-base flex items-center gap-1">
                                Promotions <ArrowUpRightOnBox className="w-3 h-3" />
                            </button>
                        </div>
                        <InlineItemsTable
                            items={order.items} curr={curr}
                            invQuery={s.invQuery} invResults={s.invResults}
                            itemQtys={s.itemQtys} setItemQtys={s.setItemQtys}
                            itemPrices={s.itemPrices} setItemPrices={s.setItemPrices}
                            searchInvItems={s.searchInvItems}
                            handleAddItem={s.handleAddItem} handleUpdateItem={s.handleUpdateItem} handleRemoveItem={s.handleRemoveItem}
                            itemSaving={s.itemSaving} customerPrices={customerPrices}
                        />
                    </Container>
                    <PromotionsBlock
                        orderId={id!} promotions={order.promotions ?? []}
                        discountTotal={order.discount_total ?? 0} curr={curr} onApplied={s.fetchOrder}
                    />
                    <Container className="p-0 overflow-hidden">
                        <div className="flex items-center justify-between px-6 py-4 border-b border-ui-border-base">
                            <Heading level="h2">Shipping</Heading>
                        </div>
                        <InlineShipping
                            orderId={id!}
                            shippingMethods={order.shipping_methods ?? []} shippingOptions={inlineShippingOptions}
                            curr={curr} saving={s.saving} loadShippingOptions={loadShippingOptions} handleAddShipping={handleAddShippingInline}
                            onRemoved={s.handleRemoveShipping}
                        />
                    </Container>
                    <Container className="p-0 overflow-hidden">
                        <div className="flex items-center justify-between px-6 py-4 border-b border-ui-border-base">
                            <Heading level="h2">Taxes</Heading>
                        </div>
                        <InlineTaxes orderId={id!} curr={curr} onTaxChange={setTaxAmount}
                            triggerKey={`${order.items.length}-${(order.shipping_methods ?? []).length}`}
                        />
                    </Container>
                    {/* ── Order Totals: subtotal computed from items (unit_price is in dollars from API) ── */}
                    {(() => {
                        const computedSubtotal = (order.items ?? []).reduce((sum: number, item: any) =>
                            sum + (item.unit_price ?? 0) * (item.quantity ?? 1), 0)
                        const shippingDollars = order.shipping_total ?? 0
                        const discountDollars = order.discount_total ?? 0
                        return (
                            <OrderTotals
                                subtotal={computedSubtotal}
                                shippingTotal={shippingDollars}
                                discountTotal={discountDollars}
                                taxTotal={taxAmount}
                                total={computedSubtotal + shippingDollars - discountDollars + taxAmount}
                                itemCount={order.items.length} curr={curr}
                            />
                        )
                    })()}
                </div>

                {/* ── Right sidebar ────────────────────────────────────────── */}
                <OrderSidebar
                    id={id!}
                    estimateRef={s.localRef ?? (order.metadata?.qb_estimate_ref as string | null) ?? null}
                    estimateTxnId={s.localTxnId ?? (order.metadata?.qb_estimate_txn_id as string | null) ?? null}
                    isSynced={!!(s.localTxnId ?? order.metadata?.qb_estimate_txn_id)}
                    estimateStatus={s.estimateStatus}
                    statusSaving={s.statusSaving} syncing={s.syncing} syncError={s.syncError}
                    timeline={s.timeline} orderCreatedAt={order.created_at}
                    onStatusChange={s.handleStatusChange} onSync={s.handleSync} onOpenModal={s.openModal as any}
                />
            </div>

            <OrderDrawers
                modal={s.modal} closeModal={s.closeModal} saving={s.saving} itemSaving={s.itemSaving} curr={curr}
                salesChannels={s.salesChannels} selectedSc={s.selectedSc} setSelectedSc={s.setSelectedSc} handleSaveSalesChannel={s.handleSaveSalesChannel}
                emailForm={s.emailForm} setEmailForm={s.setEmailForm} handleSaveEmail={s.handleSaveEmail}
                shippingAddrForm={s.shippingAddrForm} setShippingAddrForm={s.setShippingAddrForm} handleSaveShippingAddr={s.handleSaveShippingAddr}
                billingAddrForm={s.billingAddrForm} setBillingAddrForm={s.setBillingAddrForm} handleSaveBillingAddr={s.handleSaveBillingAddr}
                customerQuery={s.customerQuery} customers={s.customers} selectedCustomer={s.selectedCustomer}
                setSelectedCustomer={s.setSelectedCustomer} searchCustomers={s.searchCustomers} handleTransfer={s.handleTransfer}
                shippingOptions={s.shippingOptions} selectedOption={s.selectedOption} setSelectedOption={s.setSelectedOption}
                customAmount={s.customAmount} setCustomAmount={s.setCustomAmount} handleAddShipping={s.handleAddShipping}
                orderItems={order.items.map(i => ({ id: i.id, title: i.title, quantity: i.quantity }))}
                invQuery={s.invQuery} invResults={s.invResults}
                itemQtys={s.itemQtys} setItemQtys={s.setItemQtys} itemPrices={s.itemPrices} setItemPrices={s.setItemPrices}
                currentItems={order.items}
                searchInvItems={s.searchInvItems} handleAddItem={s.handleAddItem} handleUpdateItem={s.handleUpdateItem} handleRemoveItem={s.handleRemoveItem}
                metadataForm={s.metadataForm} setMetadataForm={s.setMetadataForm}
                metaNewKey={s.metaNewKey} setMetaNewKey={s.setMetaNewKey}
                metaNewVal={s.metaNewVal} setMetaNewVal={s.setMetaNewVal}
                handleSaveMetadata={s.handleSaveMetadata} handleAddMetaKey={s.handleAddMetaKey}
            />
        </>
    )
}

export default DraftOrderDetail

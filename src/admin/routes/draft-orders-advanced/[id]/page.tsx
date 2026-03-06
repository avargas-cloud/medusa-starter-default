import { Container, Heading, Badge, Text } from "@medusajs/ui"
import { useParams, useNavigate } from "react-router-dom"
import { useDraftOrderDetail } from "./hooks/use-draft-order-detail"
import { useOrderPageState } from "./hooks/use-order-page-state"
import { usePageDerived } from "./hooks/use-page-derived"
import { OrderDrawers } from "./components/OrderDrawers"
import { OrderHeader } from "./components/OrderHeader"
import { CustomerBlock } from "./components/CustomerBlock"
import { InlineItemsTable } from "./components/InlineItemsTable"
import { PromotionsBlock } from "./components/PromotionsBlock"
import { InlineShipping } from "./components/InlineShipping"
import { InlineTaxes } from "./components/InlineTaxes"
import { OrderTotals } from "./components/OrderTotals"
import { OrderSidebar } from "./components/OrderSidebar"
import { InlineNotes } from "./components/InlineNotes"
import { SendEstimateModal } from "./components/SendEstimateModal"
import { EstimateInfoBlock } from "./components/EstimateInfoBlock"
import type { EstimateInfo } from "./components/EstimateInfoBlock"
import { NoShippingModal } from "./components/NoShippingModal"
import { addrToLines } from "./helpers"

const DraftOrderDetail = () => {
    const { id } = useParams<{ id: string }>()
    const navigate = useNavigate()
    const s = useDraftOrderDetail(id)
    const { customerPrices, inlineShippingOptions, loadShippingOptions, handleAddShippingInline, handleReplaceShippingInline, handleUpdateShippingAmountInline } =
        useOrderPageState(s.order, s.handleAddShipping, s.handleReplaceShipping, s.handleUpdateShippingAmount)

    const p = usePageDerived({
        id, order: s.order, estimateStatus: s.estimateStatus,
        itemPrices: s.itemPrices, itemQtys: s.itemQtys,
        handleAddItem: s.handleAddItem, handleUpdateItem: s.handleUpdateItem, handleRemoveItem: s.handleRemoveItem,
        handleConvert: s.handleConvert, handleStatusChange: s.handleStatusChange,
        addTimelineEvent: s.addTimelineEvent, currentUser: s.currentUser,
    })

    if (s.loading) return <div className="p-6"><Text className="text-ui-fg-muted">Loading...</Text></div>
    if (s.fetchError || !s.order) return <div className="p-6"><Text className="text-ui-fg-error">Error: {s.fetchError ?? "Not found"}</Text></div>

    const order = s.order
    const curr = order.currency_code
    const customerName = order.customer
        ? `${order.customer.first_name ?? ""} ${order.customer.last_name ?? ""}`.trim() || order.customer.email || "—"
        : order.email || "—"
    const scName = order.sales_channel?.name === "Default Sales Channel" ? "Default" : (order.sales_channel?.name ?? "Default")
    const isWholesale = (() => {
        const cust = order.customer as any
        return (cust?.groups ?? []).some((g: any) => (g.name ?? "").toLowerCase().includes("wholesale")) ||
            (cust?.metadata?.price_level as string ?? "").toLowerCase().includes("wholesale")
    })()
    const estimateInitialInfo: EstimateInfo = {
        rep: (order.metadata?.estimate_rep ?? (order.customer as any)?.metadata?.default_rep ?? "") as string,
        orderType: (order.metadata?.estimate_order_type ?? (order.customer as any)?.metadata?.default_order_type ?? "") as string,
        leadTime: (order.metadata?.estimate_lead_time ?? (order.customer as any)?.metadata?.default_lead_time ?? "") as string,
        paymentTerms: (order.metadata?.estimate_payment_terms ?? (order.customer as any)?.metadata?.default_payment_terms ?? "") as string,
        project: (order.metadata?.estimate_project ?? "") as string,
    }

    return (
        <>
            <div className="flex gap-4 p-6">

                {/* ── Left column ─────────────────────────────────────────── */}
                <div className="flex-1 flex flex-col gap-4 min-w-0">
                    <OrderHeader
                        id={id!} displayId={order.display_id} regionName={order.region?.name}
                        createdAt={order.created_at} scName={scName} converting={s.converting}
                        onNavigateBack={() => navigate("/draft-orders-advanced")}
                        onConvert={p.handleConvertClick} onOpenModal={s.openModal as any} onDelete={s.handleDelete}
                        onSendEstimate={p.handleSendEstimate}
                        onPrintEstimate={p.handlePrintEstimate}
                    />
                    <CustomerBlock
                        customer={order.customer} customerName={customerName}
                        shippingLines={addrToLines(order.shipping_address, order.customer?.company_name)}
                        billingLines={addrToLines(order.billing_address)}
                        onOpenModal={s.openModal as any}
                    />
                    <EstimateInfoBlock
                        orderId={id!} customerId={order.customer?.id}
                        initialInfo={estimateInitialInfo}
                        onInfoChange={p.setCurrentEstimateInfo}
                    />
                    <Container className="p-0 overflow-visible">
                        <div className="flex items-center justify-between px-6 py-4 border-b border-ui-border-base">
                            <div className="flex items-center gap-2">
                                <Heading level="h2">Items</Heading>
                                {order.items.length > 0 && <Badge color="grey" size="small">{order.items.length}</Badge>}
                                {s.itemSaving && <Text size="xsmall" className="text-ui-fg-muted">Saving...</Text>}
                            </div>
                        </div>
                        <InlineItemsTable
                            items={order.items} curr={curr}
                            invQuery={s.invQuery} invResults={s.invResults}
                            itemQtys={s.itemQtys} setItemQtys={s.setItemQtys}
                            itemPrices={s.itemPrices} setItemPrices={s.setItemPrices}
                            searchInvItems={s.searchInvItems}
                            handleAddItem={p.handleAddItemWithTax} handleUpdateItem={p.handleUpdateItemWithTax} handleRemoveItem={p.handleRemoveItemWithTax}
                            itemSaving={s.itemSaving} customerPrices={customerPrices}
                            customerIsWholesale={isWholesale}
                        />
                    </Container>
                    <PromotionsBlock
                        orderId={id!} promotions={order.promotions ?? []}
                        discountTotal={order.discount_total ?? 0} curr={curr} onApplied={s.fetchOrder}
                    />
                    <Container className="p-0 overflow-hidden">
                        <div className="flex items-center justify-between px-6 py-4 border-b border-ui-border-base">
                            <Heading level="h2">Notes</Heading>
                        </div>
                        <InlineNotes orderId={id!} initialNotes={(order.metadata?.estimate_notes as string | undefined) ?? ""} />
                    </Container>
                    <Container className="p-0 overflow-hidden">
                        <InlineShipping
                            ref={p.shippingRef}
                            orderId={id!}
                            shippingMethods={order.shipping_methods ?? []} shippingOptions={inlineShippingOptions}
                            curr={curr} shippingSaving={s.shippingSaving} loadShippingOptions={loadShippingOptions} handleAddShipping={handleAddShippingInline}
                            onRemoved={s.handleRemoveShipping}
                            onShippingChanged={p.bumpTax}
                            onReplaceShipping={handleReplaceShippingInline}
                            onUpdateShippingAmount={handleUpdateShippingAmountInline}
                        />
                    </Container>
                    <Container className="p-0 overflow-hidden">
                        <div className="flex items-center justify-between px-6 py-4 border-b border-ui-border-base">
                            <Heading level="h2">Taxes</Heading>
                        </div>
                        <InlineTaxes orderId={id!} curr={curr} onTaxChange={p.setTaxAmount} onTaxRateChange={p.setTaxRate} triggerKey={p.taxTrigger} />
                    </Container>
                    <OrderTotals
                        subtotal={p.computedSubtotal} shippingTotal={p.shippingDollars}
                        discountTotal={p.discountDollars} taxTotal={p.taxAmount}
                        total={p.computedTotal} itemCount={order.items.length} curr={curr}
                        taxRate={p.taxRate}
                    />
                </div>

                {/* ── Right sidebar ─────────────────────────────────────────── */}
                <OrderSidebar
                    id={id!}
                    estimateRef={s.localRef ?? (order.metadata?.qb_estimate_ref as string | null) ?? null}
                    estimateTxnId={s.localTxnId ?? (order.metadata?.qb_estimate_txn_id as string | null) ?? null}
                    isSynced={!!(s.localTxnId ?? order.metadata?.qb_estimate_txn_id)}
                    estimateStatus={s.estimateStatus}
                    statusSaving={s.statusSaving} syncing={s.syncing} syncError={s.syncError}
                    timeline={s.timeline} orderCreatedAt={order.created_at}
                    total={p.computedTotal}
                    onStatusChange={s.handleStatusChange} onSync={s.handleSync} onOpenModal={s.openModal as any}
                />
            </div>

            <OrderDrawers
                modal={s.modal} closeModal={s.closeModal} saving={s.saving} itemSaving={s.itemSaving} curr={curr}
                customerId={order.customer?.id}
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

            <NoShippingModal
                showNoShippingModal={p.showNoShippingModal}
                onClose={() => p.setShowNoShippingModal(false)}
                onLocalPickup={p.handleAutoLocalPickup}
                onChooseManually={p.handleScrollToShipping}
                shippingRef={p.shippingRef}
            />

            {p.showEstimateModal && (
                <SendEstimateModal
                    open={p.showEstimateModal}
                    onClose={() => p.setShowEstimateModal(false)}
                    onSuccess={p.handleEstimateSuccess}
                    orderId={id!}
                    displayId={order.display_id}
                    customerEmail={order.customer?.email ?? order.email}
                    total={p.estimateTotal}
                    curr={curr}
                />
            )}
        </>
    )
}

export default DraftOrderDetail

import { Container, Heading, Badge, Text } from "@medusajs/ui"
import { useParams, useNavigate } from "react-router-dom"
import { useState, useCallback, useEffect, useRef } from "react"
import { useDraftOrderDetail } from "./hooks/use-draft-order-detail"
import { useOrderPageState } from "./hooks/use-order-page-state"
import { OrderDrawers } from "./components/OrderDrawers"
import { OrderHeader } from "./components/OrderHeader"
import { CustomerBlock } from "./components/CustomerBlock"
import { InlineItemsTable } from "./components/InlineItemsTable"
import { PromotionsBlock } from "./components/PromotionsBlock"
import { InlineShipping, type InlineShippingHandle } from "./components/InlineShipping"
import { InlineTaxes } from "./components/InlineTaxes"
import { OrderTotals } from "./components/OrderTotals"
import { OrderSidebar } from "./components/OrderSidebar"
import { InlineNotes } from "./components/InlineNotes"
import { SendEstimateModal } from "./components/SendEstimateModal"
import { EstimateInfoBlock, getMissingEstimateFields } from "./components/EstimateInfoBlock"
import type { EstimateInfo } from "./components/EstimateInfoBlock"
import { NoShippingModal } from "./components/NoShippingModal"
import { addrToLines } from "./helpers"

const DraftOrderDetail = () => {
    const { id } = useParams<{ id: string }>()
    const navigate = useNavigate()
    const s = useDraftOrderDetail(id)
    const { customerPrices, inlineShippingOptions, loadShippingOptions, handleAddShippingInline } =
        useOrderPageState(s.order, s.handleAddShipping)
    const { currentUser, addTimelineEvent } = s
    const [taxAmount, setTaxAmount] = useState(0)
    const taxInitialized = useRef(false)
    // Seed taxAmount immediately from the order's stored tax_total (already normalized to dollars).
    // This prevents the 2-second flash where OrderTotals shows $199 before compute-tax returns $213.
    useEffect(() => {
        if (!taxInitialized.current && s.order?.tax_total != null && s.order.tax_total > 0) {
            setTaxAmount(s.order.tax_total)
            taxInitialized.current = true
        }
    }, [s.order?.tax_total])
    const [showEstimateModal, setShowEstimateModal] = useState(false)
    const [currentEstimateInfo, setCurrentEstimateInfo] = useState<EstimateInfo | null>(null)
    const [showNoShippingModal, setShowNoShippingModal] = useState(false)
    const shippingRef = useRef<InlineShippingHandle>(null)
    const shippingSectionRef = useRef<HTMLDivElement>(null)
    // Increment to trigger InlineTaxes re-fetch after every confirmed item mutation
    const [taxTrigger, setTaxTrigger] = useState(0)
    const bumpTax = useCallback(() => setTaxTrigger(n => n + 1), [])

    // Wrapped handlers: auto-refresh taxes after confirmed save
    const handleAddItemWithTax = useCallback(async (variantId: string, overridePrice?: number) => {
        await s.handleAddItem(variantId, overridePrice)
        bumpTax()
    }, [s.handleAddItem, bumpTax])
    const handleUpdateItemWithTax = useCallback(async (itemId: string) => {
        await s.handleUpdateItem(itemId)
        bumpTax()
    }, [s.handleUpdateItem, bumpTax])
    const handleRemoveItemWithTax = useCallback(async (itemId: string) => {
        await s.handleRemoveItem(itemId)
        bumpTax()
    }, [s.handleRemoveItem, bumpTax])

    if (s.loading) return <div className="p-6"><Text className="text-ui-fg-muted">Loading...</Text></div>
    if (s.fetchError || !s.order) return <div className="p-6"><Text className="text-ui-fg-error">Error: {s.fetchError ?? "Not found"}</Text></div>

    const order = s.order

    // ── Convert intercept: check for shipping method before proceeding ─────────────
    const handleConvertClick = () => {
        const hasShipping = (order.shipping_methods ?? []).length > 0
        if (!hasShipping) { setShowNoShippingModal(true); return }
        s.handleConvert()
    }
    const handleScrollToShipping = () => {
        setShowNoShippingModal(false)
        shippingSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })
        setTimeout(() => shippingRef.current?.openPicker(), 500)
    }
    const handleAutoLocalPickup = async () => {
        setShowNoShippingModal(false)
        const found = await shippingRef.current?.applyLocalPickup()
        if (!found) { handleScrollToShipping(); return }
        setTimeout(() => s.handleConvert(), 400)
    }

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
                        onConvert={handleConvertClick} onOpenModal={s.openModal as any} onDelete={s.handleDelete}
                        onSendEstimate={() => {
                            const info = currentEstimateInfo
                            if (!info) { setShowEstimateModal(true); return }
                            const missing = getMissingEstimateFields(info)
                            if (missing.length > 0) {
                                // Import toast inline to avoid circular dep
                                import("@medusajs/ui").then(({ toast }) =>
                                    toast.error(`Please fill in: ${missing.join(", ")}`, { description: "These fields are required before sending an estimate." })
                                )
                                return
                            }
                            setShowEstimateModal(true)
                        }}
                        onPrintEstimate={() => {
                            const info = currentEstimateInfo
                            const missing = info ? getMissingEstimateFields(info) : []
                            if (missing.length > 0) {
                                import("@medusajs/ui").then(({ toast }) =>
                                    toast.error(`Please fill in: ${missing.join(", ")}`, { description: "These fields are required before printing an estimate." })
                                )
                                return
                            }
                            // Hidden iframe: loads ?mode=print HTML which auto-calls window.print()
                            // → Chrome print dialog opens directly, no new tab visible to user
                            const iframe = document.createElement("iframe")
                            iframe.style.cssText = "position:fixed;top:-9999px;left:-9999px;width:1px;height:1px;border:0;"
                            document.body.appendChild(iframe)
                            iframe.onload = () => {
                                // The autoPrint script inside the HTML calls window.print() on load
                                // Give it a moment then clean up after the dialog would have opened
                                setTimeout(() => {
                                    try { document.body.removeChild(iframe) } catch { }
                                }, 120_000) // clean up after 2 min max
                            }
                            iframe.src = `/admin/draft-orders/${id}/send-estimate?mode=print`
                        }}
                    />
                    <CustomerBlock
                        customer={order.customer} customerName={customerName}
                        shippingLines={addrToLines(order.shipping_address, order.customer?.company_name)}
                        billingLines={addrToLines(order.billing_address)}
                        onOpenModal={s.openModal as any}
                    />
                    {/* ── Estimate Details: Rep, Order Type, Lead Time, Payment Terms, Project ── */}
                    {(() => {
                        const m = order.metadata ?? {}
                        const cm: any = (order.customer as any)?.metadata ?? {}
                        const initialInfo: EstimateInfo = {
                            rep: (m.estimate_rep ?? cm.default_rep ?? "") as string,
                            orderType: (m.estimate_order_type ?? cm.default_order_type ?? "") as string,
                            leadTime: (m.estimate_lead_time ?? cm.default_lead_time ?? "") as string,
                            paymentTerms: (m.estimate_payment_terms ?? cm.default_payment_terms ?? "") as string,
                            project: (m.estimate_project ?? "") as string,
                        }
                        return (
                            <EstimateInfoBlock
                                orderId={id!}
                                customerId={order.customer?.id}
                                initialInfo={initialInfo}
                                onInfoChange={setCurrentEstimateInfo}
                            />
                        )
                    })()}
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
                            handleAddItem={handleAddItemWithTax} handleUpdateItem={handleUpdateItemWithTax} handleRemoveItem={handleRemoveItemWithTax}
                            itemSaving={s.itemSaving} customerPrices={customerPrices}
                            customerIsWholesale={(() => {
                                const cust = order.customer as any
                                return (cust?.groups ?? []).some((g: any) => (g.name ?? '').toLowerCase().includes('wholesale')) ||
                                    (cust?.metadata?.price_level as string ?? '').toLowerCase().includes('wholesale')
                            })()}
                        />
                    </Container>
                    <PromotionsBlock
                        orderId={id!} promotions={order.promotions ?? []}
                        discountTotal={order.discount_total ?? 0} curr={curr} onApplied={s.fetchOrder}
                    />
                    {/* ── Notes ─────────────────────────────────────────── */}
                    <Container className="p-0 overflow-hidden">
                        <div className="flex items-center justify-between px-6 py-4 border-b border-ui-border-base">
                            <Heading level="h2">Notes</Heading>
                        </div>
                        <InlineNotes
                            orderId={id!}
                            initialNotes={(order.metadata?.estimate_notes as string | undefined) ?? ""}
                        />
                    </Container>
                    <Container className="p-0 overflow-hidden">
                        <div ref={shippingSectionRef} className="flex items-center justify-between px-6 py-4 border-b border-ui-border-base">
                            <Heading level="h2">Shipping</Heading>
                        </div>
                        <InlineShipping
                            ref={shippingRef}
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
                            triggerKey={taxTrigger}
                        />
                    </Container>
                    {/* ── Order Totals: subtotal uses UI-selected price (itemPrices) if available,
                         falling back to server unit_price. This ensures total reflects the
                         dropdown selection immediately, before the 3-second autosave fires. ── */}
                    {(() => {
                        const computedSubtotal = (order.items ?? []).reduce((sum: number, item: any) => {
                            const selectedPrice = s.itemPrices[item.id]
                            const price = selectedPrice !== undefined
                                ? parseFloat(selectedPrice)
                                : (item.unit_price ?? 0)
                            // Use live itemQtys state (same as the line-item Total column)
                            // so the subtotal updates immediately when qty stepper is clicked,
                            // without waiting for the 3s autosave + re-fetch cycle.
                            const qty = s.itemQtys[item.id] ?? item.quantity ?? 1
                            return sum + price * qty
                        }, 0)
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
                showNoShippingModal={showNoShippingModal}
                onClose={() => setShowNoShippingModal(false)}
                onLocalPickup={handleAutoLocalPickup}
                onChooseManually={handleScrollToShipping}
                shippingRef={shippingRef}
            />
            {showEstimateModal && (
                <SendEstimateModal
                    open={showEstimateModal}
                    onClose={() => setShowEstimateModal(false)}
                    onSuccess={(sentTo) => {
                        // Add Email Sent activity to timeline immediately (no re-fetch)
                        addTimelineEvent(
                            "Email Sent",
                            `Estimate emailed to ${sentTo}`,
                            currentUser || undefined
                        )
                        // Auto-advance status: Created → Sent
                        if (s.estimateStatus === "Created") {
                            s.handleStatusChange("Sent")
                        }
                    }}
                    orderId={id!}
                    displayId={order.display_id}
                    customerEmail={order.customer?.email ?? order.email}
                    total={(order.items ?? []).reduce((acc, i: any) => {
                        const sel = s.itemPrices[i.id]
                        const price = sel !== undefined ? parseFloat(sel) : (i.unit_price ?? 0)
                        const qty = s.itemQtys[i.id] ?? i.quantity ?? 1
                        return acc + price * qty
                    }, 0) + (order.shipping_total ?? 0) - (order.discount_total ?? 0) + taxAmount}
                    curr={curr}
                />
            )}
        </>
    )
}

export default DraftOrderDetail

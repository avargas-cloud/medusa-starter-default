import { Input, Label, Text, Select } from "@medusajs/ui"
import { Trash, PencilSquare, Check, Plus, Minus } from "@medusajs/icons"
import { Drawer } from "./Drawer"
import { AddrFormFields } from "./AddrFormFields"
import type { AddrForm, VariantResult } from "../types"
import { useState } from "react"

// ─── EditItemsTable ───────────────────────────────────────────────────────────
interface EditItemsTableProps {
    curr: string
    currentItems: { id: string; title: string; quantity: number; unit_price: number; variant?: { sku?: string; title?: string } }[]
    invQuery: string
    invResults: VariantResult[]
    itemQtys: Record<string, number>
    setItemQtys: React.Dispatch<React.SetStateAction<Record<string, number>>>
    itemPrices: Record<string, string>
    setItemPrices: React.Dispatch<React.SetStateAction<Record<string, string>>>
    itemSaving: boolean
    searchInvItems: (q: string) => void
    handleAddItem: (variantId: string) => void
    handleUpdateItem: (itemId: string) => void
    handleRemoveItem: (itemId: string) => void
}

const EditItemsTable = (p: EditItemsTableProps) => {
    const [editingId, setEditingId] = useState<string | null>(null)
    const fmt = (v: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: p.curr.toUpperCase() }).format(v)

    const totalQty = p.currentItems.reduce((s, i) => s + (p.itemQtys[i.id] ?? i.quantity), 0)
    const totalVal = p.currentItems.reduce((s, i) => {
        const price = parseFloat(p.itemPrices[i.id] ?? String(i.unit_price)) || 0
        const qty = p.itemQtys[i.id] ?? i.quantity
        return s + (price * qty)
    }, 0)

    const handleSave = async (itemId: string) => {
        await p.handleUpdateItem(itemId)
        setEditingId(null)
    }

    return (
        <div className="flex flex-col h-full">
            {/* Items section header with search */}
            <div className="flex items-start justify-between px-6 py-4 border-b border-ui-border-base">
                <div>
                    <Text size="small" weight="plus">Items</Text>
                    <Text size="xsmall" className="text-ui-fg-subtle">Choose items from the product catalog.</Text>
                </div>
                <div className="relative w-56">
                    <Input
                        placeholder="Search items..."
                        value={p.invQuery}
                        onChange={e => p.searchInvItems(e.target.value)}
                        className="pr-8"
                    />
                    <span className="absolute right-2 top-1/2 -translate-y-1/2 text-ui-fg-muted"><Plus /></span>
                    {p.invResults.length > 0 && (
                        <div className="absolute top-full left-0 right-0 z-10 mt-1 border border-ui-border-base rounded-md bg-ui-bg-base shadow-xl overflow-hidden max-h-72 overflow-y-auto">
                            {p.invResults.map(item => (
                                <button key={item.id} onClick={() => { p.handleAddItem(item.id); }}
                                    className="w-full text-left px-3 py-2 hover:bg-ui-bg-subtle-hover border-b last:border-0 border-ui-border-base flex items-center gap-2">
                                    {item.thumbnail && <img src={item.thumbnail} alt="" className="w-7 h-7 rounded object-cover shrink-0" />}
                                    <div className="min-w-0 flex-1">
                                        <Text size="xsmall" weight="plus" className="truncate block">{item.title}</Text>
                                        {item.variantTitle && <Text size="xsmall" className="text-ui-fg-subtle block truncate">{item.variantTitle}</Text>}
                                        {item.sku && <Text size="xsmall" className="text-ui-fg-muted font-mono block">{item.sku}</Text>}
                                    </div>
                                </button>
                            ))}
                        </div>
                    )}
                    {p.invQuery && p.invResults.length === 0 && (
                        <div className="absolute top-full left-0 right-0 z-10 mt-1 border border-ui-border-base rounded-md bg-ui-bg-base shadow-xl p-3">
                            <Text size="xsmall" className="text-ui-fg-muted">No products found.</Text>
                        </div>
                    )}
                </div>
            </div>

            {/* Table header */}
            <div className="grid grid-cols-[auto_1fr_120px_140px_40px] gap-x-3 px-6 py-2 bg-ui-bg-subtle border-b border-ui-border-base">
                <div className="w-5" />
                <Text size="xsmall" weight="plus" className="text-ui-fg-muted uppercase tracking-wider">Item</Text>
                <Text size="xsmall" weight="plus" className="text-ui-fg-muted uppercase tracking-wider text-center">Quantity</Text>
                <Text size="xsmall" weight="plus" className="text-ui-fg-muted uppercase tracking-wider text-right">Price</Text>
                <div />
            </div>

            {/* Rows */}
            <div className="flex-1 overflow-auto">
                {p.currentItems.length === 0 && (
                    <div className="px-6 py-8 text-center">
                        <Text size="small" className="text-ui-fg-subtle">No items yet. Use the search to add items.</Text>
                    </div>
                )}
                {p.currentItems.map(item => {
                    const isEditing = editingId === item.id
                    const qty = p.itemQtys[item.id] ?? item.quantity
                    const priceStr = p.itemPrices[item.id] ?? String(item.unit_price)
                    const priceVal = parseFloat(priceStr) || 0

                    return (
                        <div key={item.id} className={`grid grid-cols-[auto_1fr_120px_140px_40px] gap-x-3 px-6 py-3 border-b border-ui-border-base items-center transition-colors ${isEditing ? "bg-ui-bg-subtle" : "hover:bg-ui-bg-subtle-hover"}`}>
                            {/* Pencil toggle */}
                            <button
                                onClick={() => setEditingId(isEditing ? null : item.id)}
                                className={`w-5 h-5 flex items-center justify-center rounded transition-colors ${isEditing ? "text-ui-fg-interactive" : "text-ui-fg-muted hover:text-ui-fg-base"}`}>
                                <PencilSquare />
                            </button>

                            {/* Item info */}
                            <div className="min-w-0">
                                <Text size="small" weight="plus" className="truncate block">{item.title}</Text>
                                {item.variant?.title && item.variant.title !== item.title && (
                                    <Text size="xsmall" className="text-ui-fg-subtle block truncate">{item.variant.title}</Text>
                                )}
                                {item.variant?.sku && (
                                    <Text size="xsmall" className="text-ui-fg-muted font-mono block">{item.variant.sku}</Text>
                                )}
                            </div>

                            {/* Quantity — static or stepper */}
                            {isEditing ? (
                                <div className="flex items-center justify-center gap-1">
                                    <button
                                        className="w-6 h-6 flex items-center justify-center rounded border border-ui-border-base hover:bg-ui-bg-subtle-hover text-ui-fg-muted"
                                        onClick={() => p.setItemQtys(q => ({ ...q, [item.id]: Math.max(1, qty - 1) }))}>
                                        <Minus />
                                    </button>
                                    <input
                                        type="number" min="1" value={qty}
                                        onChange={e => p.setItemQtys(q => ({ ...q, [item.id]: parseInt(e.target.value) || 1 }))}
                                        className="w-10 text-center text-sm bg-transparent border-b border-ui-border-base focus:outline-none focus:border-ui-fg-interactive"
                                    />
                                    <button
                                        className="w-6 h-6 flex items-center justify-center rounded border border-ui-border-base hover:bg-ui-bg-subtle-hover text-ui-fg-muted"
                                        onClick={() => p.setItemQtys(q => ({ ...q, [item.id]: qty + 1 }))}>
                                        <Plus />
                                    </button>
                                </div>
                            ) : (
                                <Text size="small" className="text-center text-ui-fg-subtle">{qty}</Text>
                            )}

                            {/* Price — static or input */}
                            {isEditing ? (
                                <div className="flex items-center gap-1 justify-end">
                                    <Text size="xsmall" className="text-ui-fg-muted uppercase">{p.curr}</Text>
                                    <input
                                        type="number" min="0" step="0.01" value={priceStr}
                                        onChange={e => p.setItemPrices(pr => ({ ...pr, [item.id]: e.target.value }))}
                                        className="w-20 text-right text-sm bg-transparent border-b border-ui-border-base focus:outline-none focus:border-ui-fg-interactive"
                                    />
                                    <button
                                        onClick={() => handleSave(item.id)}
                                        disabled={p.itemSaving}
                                        className="w-6 h-6 flex items-center justify-center rounded border border-ui-border-base bg-ui-bg-interactive hover:opacity-90 text-ui-fg-on-color shrink-0 ml-1">
                                        <Check />
                                    </button>
                                </div>
                            ) : (
                                <Text size="small" className="text-right">{fmt(priceVal * qty)}</Text>
                            )}

                            {/* Remove */}
                            <button
                                onClick={() => p.handleRemoveItem(item.id)}
                                className="w-5 h-5 flex items-center justify-center text-ui-fg-muted hover:text-ui-fg-error transition-colors">
                                <Trash />
                            </button>
                        </div>
                    )
                })}
            </div>

            {/* Subtotal */}
            <div className="flex items-center justify-between px-6 py-4 border-t border-ui-border-base bg-ui-bg-subtle">
                <Text size="small" weight="plus">Subtotal</Text>
                <div className="flex items-center gap-6">
                    <Text size="small" className="text-ui-fg-subtle">{totalQty} item{totalQty !== 1 ? "s" : ""}</Text>
                    <Text size="small" weight="plus">{fmt(totalVal)} {p.curr.toUpperCase()}</Text>
                </div>
            </div>
        </div>
    )
}

// ─── All Drawer types ─────────────────────────────────────────────────────────
type ModalType = "sales-channel" | "email" | "shipping-addr" | "billing-addr" | "transfer" | "add-shipping" | "edit-items" | "metadata" | null

interface OrderDrawersProps {
    modal: ModalType
    closeModal: () => void
    saving: boolean
    itemSaving: boolean
    curr: string
    // Customer ID — used to load saved addresses in address drawers
    customerId?: string
    // Sales Channel
    salesChannels: { id: string; name: string }[]
    selectedSc: string; setSelectedSc: (v: string) => void
    handleSaveSalesChannel: () => void
    // Email
    emailForm: string; setEmailForm: (v: string) => void
    handleSaveEmail: () => void
    // Shipping address
    shippingAddrForm: AddrForm; setShippingAddrForm: React.Dispatch<React.SetStateAction<AddrForm>>
    handleSaveShippingAddr: () => void
    // Billing address
    billingAddrForm: AddrForm; setBillingAddrForm: React.Dispatch<React.SetStateAction<AddrForm>>
    handleSaveBillingAddr: () => void
    // Transfer
    customerQuery: string
    customers: { id: string; first_name?: string; last_name?: string; email?: string; company_name?: string }[]
    selectedCustomer: string; setSelectedCustomer: (v: string) => void
    searchCustomers: (q: string) => void
    handleTransfer: () => void
    // Add Shipping
    shippingOptions: { id: string; name: string; amount: number }[]
    selectedOption: string; setSelectedOption: (v: string) => void
    customAmount: string; setCustomAmount: (v: string) => void
    handleAddShipping: () => void
    orderItems: { id: string; title: string; quantity: number }[]
    // Edit Items
    invQuery: string
    invResults: VariantResult[]
    itemQtys: Record<string, number>; setItemQtys: React.Dispatch<React.SetStateAction<Record<string, number>>>
    itemPrices: Record<string, string>; setItemPrices: React.Dispatch<React.SetStateAction<Record<string, string>>>
    currentItems: { id: string; title: string; quantity: number; unit_price: number; variant?: { sku?: string } }[]
    searchInvItems: (q: string) => void
    handleAddItem: (variantId: string) => void
    handleUpdateItem: (itemId: string) => void
    handleRemoveItem: (itemId: string) => void
    // Metadata
    metadataForm: Record<string, string>; setMetadataForm: React.Dispatch<React.SetStateAction<Record<string, string>>>
    metaNewKey: string; setMetaNewKey: (v: string) => void
    metaNewVal: string; setMetaNewVal: (v: string) => void
    handleSaveMetadata: () => void
    handleAddMetaKey: () => void
}

export const OrderDrawers = (props: OrderDrawersProps) => {
    const {
        modal, closeModal, saving, itemSaving, curr, customerId,
        salesChannels, selectedSc, setSelectedSc, handleSaveSalesChannel,
        emailForm, setEmailForm, handleSaveEmail,
        shippingAddrForm, setShippingAddrForm, handleSaveShippingAddr,
        billingAddrForm, setBillingAddrForm, handleSaveBillingAddr,
        customerQuery, customers, selectedCustomer, setSelectedCustomer, searchCustomers, handleTransfer,
        shippingOptions, selectedOption, setSelectedOption, customAmount, setCustomAmount, handleAddShipping, orderItems,
        invQuery, invResults, itemQtys, setItemQtys, itemPrices, setItemPrices,
        currentItems, searchInvItems, handleAddItem, handleUpdateItem, handleRemoveItem,
        metadataForm,
    } = props

    return (
        <>
            {/* Edit Sales Channel */}
            <Drawer open={modal === "sales-channel"} onClose={closeModal} title="Edit Sales Channel" onSave={handleSaveSalesChannel} saving={saving}>
                <div>
                    <Label className="mb-2 block text-sm">Sales Channel</Label>
                    <Select value={selectedSc} onValueChange={setSelectedSc}>
                        <Select.Trigger className="w-full"><Select.Value placeholder="Select channel..." /></Select.Trigger>
                        <Select.Content>{salesChannels.map(sc => <Select.Item key={sc.id} value={sc.id}>{sc.name}</Select.Item>)}</Select.Content>
                    </Select>
                </div>
            </Drawer>

            {/* Edit Email */}
            <Drawer open={modal === "email"} onClose={closeModal} title="Edit Email" onSave={handleSaveEmail} saving={saving}>
                <div>
                    <Label className="mb-2 block text-sm">Email</Label>
                    <Input type="email" value={emailForm} onChange={e => setEmailForm(e.target.value)} placeholder="customer@email.com" />
                </div>
            </Drawer>

            {/* Edit Shipping Address */}
            <Drawer open={modal === "shipping-addr"} onClose={closeModal} title="Edit Shipping Address" onSave={handleSaveShippingAddr} saving={saving}>
                <AddrFormFields
                    form={shippingAddrForm}
                    onChange={(k, v) => setShippingAddrForm(f => ({ ...f, [k]: v }))}
                    customerId={customerId}
                />
            </Drawer>

            {/* Edit Billing Address */}
            <Drawer open={modal === "billing-addr"} onClose={closeModal} title="Edit Billing Address" onSave={handleSaveBillingAddr} saving={saving}>
                <AddrFormFields
                    form={billingAddrForm}
                    onChange={(k, v) => setBillingAddrForm(f => ({ ...f, [k]: v }))}
                    customerId={customerId}
                />
            </Drawer>

            {/* Transfer Ownership */}
            <Drawer open={modal === "transfer"} onClose={closeModal} title="Transfer Ownership" onSave={handleTransfer} saving={saving} saveLabel="Transfer">
                <div className="space-y-3">
                    <div>
                        <Label className="mb-2 block text-sm">Search customer</Label>
                        <Input placeholder="Name or email..." value={customerQuery} onChange={e => searchCustomers(e.target.value)} />
                    </div>
                    {customers.length > 0 && (
                        <div className="border border-ui-border-base rounded-md overflow-hidden">
                            {customers.map(c => (
                                <button key={c.id} onClick={() => { setSelectedCustomer(c.id); /* TODO: update query */ }}
                                    className={`w-full text-left px-4 py-3 hover:bg-ui-bg-subtle-hover border-b last:border-0 border-ui-border-base ${selectedCustomer === c.id ? "bg-ui-bg-interactive text-ui-fg-on-color" : ""}`}>
                                    <Text size="small" weight="plus">{`${c.first_name ?? ""} ${c.last_name ?? ""}`.trim() || "—"}</Text>
                                    {c.company_name && <Text size="xsmall" className="text-ui-fg-subtle">{c.company_name}</Text>}
                                    <Text size="xsmall" className="text-ui-fg-muted">{c.email}</Text>
                                </button>
                            ))}
                        </div>
                    )}
                    {selectedCustomer && <Text size="xsmall" className="text-ui-fg-interactive">✓ Selected</Text>}
                </div>
            </Drawer>

            {/* Add / Edit Shipping */}
            <Drawer open={modal === "add-shipping"} onClose={closeModal} title={orderItems.length > 0 ? "Edit Shipping" : "Add Shipping"}
                subtitle="Choose which shipping method to use for the items in this order."
                onSave={handleAddShipping} saving={saving} saveLabel="Add" noPadding>
                <div className="px-6 py-5 space-y-5">
                    {/* Items to ship */}
                    {orderItems.length > 0 && (
                        <div className="border border-ui-border-base rounded-md overflow-hidden">
                            <div className="grid grid-cols-[1fr_auto] px-4 py-2 bg-ui-bg-subtle border-b border-ui-border-base">
                                <Text size="xsmall" weight="plus" className="text-ui-fg-muted uppercase tracking-wider">Shipping Profile</Text>
                                <Text size="xsmall" weight="plus" className="text-ui-fg-muted uppercase tracking-wider">Action</Text>
                            </div>
                            <div className="px-4 py-3 border-b border-ui-border-base flex items-center justify-between">
                                <div className="flex items-center gap-2">
                                    <div className="w-6 h-6 rounded-full bg-ui-bg-subtle-hover border border-ui-border-base flex items-center justify-center text-ui-fg-muted text-xs">✦</div>
                                    <div>
                                        <Text size="small" weight="plus">Default Shipping Profile</Text>
                                        <Text size="xsmall" className="text-ui-fg-subtle">{orderItems.length} item{orderItems.length !== 1 ? "s" : ""}</Text>
                                    </div>
                                </div>
                            </div>
                            {orderItems.map(item => (
                                <div key={item.id} className="flex items-center gap-3 px-4 py-2 border-b last:border-0 border-ui-border-base bg-ui-bg-subtle/30">
                                    <Text size="xsmall" className="text-ui-fg-muted w-6 text-right shrink-0">{item.quantity}x</Text>
                                    <Text size="xsmall">{item.title}</Text>
                                </div>
                            ))}
                        </div>
                    )}

                    {/* Shipping option selection — clickable cards (avoids Select z-index issues) */}
                    <div>
                        <Text size="xsmall" weight="plus" className="text-ui-fg-muted uppercase tracking-wider mb-2">Select Shipping Option</Text>
                        {shippingOptions.length === 0 && (
                            <Text size="xsmall" className="text-ui-fg-muted">Loading options...</Text>
                        )}
                        <div className="border border-ui-border-base rounded-md overflow-hidden">
                            {shippingOptions.map(o => (
                                <button key={o.id} onClick={() => setSelectedOption(o.id)}
                                    className={`w-full flex items-center justify-between px-4 py-3 border-b last:border-0 border-ui-border-base text-left transition-colors
                                        ${selectedOption === o.id ? "bg-ui-bg-interactive/10 border-l-2 border-l-ui-fg-interactive" : "hover:bg-ui-bg-subtle-hover"}`}>
                                    <div className="flex items-center gap-3">
                                        <div className={`w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 ${selectedOption === o.id ? "border-ui-fg-interactive" : "border-ui-border-base"}`}>
                                            {selectedOption === o.id && <div className="w-2 h-2 rounded-full bg-ui-fg-interactive" />}
                                        </div>
                                        <Text size="small" weight={selectedOption === o.id ? "plus" : "regular"}>{o.name}</Text>
                                    </div>
                                    <Text size="small" className="text-ui-fg-subtle">
                                        {o.amount > 0 ? new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(o.amount / 100) : "Free"}
                                    </Text>
                                </button>
                            ))}
                        </div>
                    </div>

                    {/* Custom amount override */}
                    <div>
                        <Label className="mb-1 block text-sm">Custom amount override (optional)</Label>
                        <Input type="number" min="0" step="0.01" value={customAmount} onChange={e => setCustomAmount(e.target.value)} placeholder="0.00" />
                        <Text size="xsmall" className="text-ui-fg-muted mt-1">Leave blank to use the option's default price.</Text>
                    </div>
                </div>
            </Drawer>

            {/* Edit Items — table layout with inline row editing */}
            <Drawer
                open={modal === "edit-items"}
                onClose={closeModal}
                title="Edit Items"
                subtitle="Edit the items in the draft order"
                width="680px"
                noPadding
            >
                <EditItemsTable
                    curr={curr}
                    currentItems={currentItems}
                    invQuery={invQuery}
                    invResults={invResults}
                    itemQtys={itemQtys}
                    setItemQtys={setItemQtys}
                    itemPrices={itemPrices}
                    setItemPrices={setItemPrices}
                    itemSaving={itemSaving}
                    searchInvItems={searchInvItems}
                    handleAddItem={handleAddItem}
                    handleUpdateItem={handleUpdateItem}
                    handleRemoveItem={handleRemoveItem}
                />
            </Drawer>

            {/* Metadata — read-only display */}
            <Drawer open={modal === "metadata"} onClose={closeModal} title="Metadata">
                <div className="space-y-2">
                    {Object.keys(metadataForm).length === 0 ? (
                        <Text size="small" className="text-ui-fg-muted">No metadata on this order.</Text>
                    ) : (
                        <div className="border border-ui-border-base rounded-md overflow-hidden">
                            {Object.entries(metadataForm).map(([k, v]) => (
                                <div key={k} className="grid grid-cols-[1fr_1fr] gap-4 px-4 py-3 border-b last:border-0 border-ui-border-base">
                                    <Text size="xsmall" weight="plus" className="text-ui-fg-muted font-mono truncate">{k}</Text>
                                    <Text size="xsmall" className="text-ui-fg-base font-mono truncate">{String(v ?? "")}</Text>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            </Drawer>
        </>
    )
}

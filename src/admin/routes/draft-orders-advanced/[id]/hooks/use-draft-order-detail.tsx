/**
 * useDraftOrderDetail — thin orchestrator
 *
 * Delegates to focused sub-hooks and assembles one unified return object
 * so page.tsx and OrderDrawers keep identical call sites.
 */
import { useState } from "react"
import { useOrderFetch } from "./use-order-fetch"
import { useOrderItems } from "./use-order-items"
import { useOrderModal } from "./use-order-modal"
import { useOrderShipping } from "./use-order-shipping"
import { useOrderActions } from "./use-order-actions"
import { EstimateStatus } from "../types"

export const useDraftOrderDetail = (id: string | undefined) => {
    // Shared state that multiple sub-hooks need to read or write
    const [estimateStatus, setEstimateStatus] = useState<EstimateStatus | "">("")

    // ── Order fetch + timeline ────────────────────────────────────────────────
    const fetch_ = useOrderFetch(
        id,
        () => { }, // itemQtys setter — items hook owns its own state; fetch seeds it separately
        () => { }, // itemPrices setter — same
        setEstimateStatus,
    )
    const { order, setOrder, loading, fetchError, fetchOrder, timeline, currentUser, addTimelineEvent } = fetch_

    // ── Items ─────────────────────────────────────────────────────────────────
    const items = useOrderItems({ id, order, setOrder })
    const { invQuery, invResults, itemQtys, setItemQtys, itemPrices, setItemPrices, itemSaving, searchInvItems, handleAddItem, handleUpdateItem, handleRemoveItem } = items

    // ── Modal ─────────────────────────────────────────────────────────────────
    const modal_ = useOrderModal({
        id, order,
        setItemQtys, setItemPrices,
        metadataForm: {},
        setMetadataForm: () => { },
        setMetaNewKey: () => { },
        setMetaNewVal: () => { },
        fetchOrder,
    })
    const { modal, saving, itemActionMap,
        salesChannels, selectedSc, setSelectedSc,
        emailForm, setEmailForm,
        shippingAddrForm, setShippingAddrForm,
        billingAddrForm, setBillingAddrForm,
        customerQuery, customers, selectedCustomer, setSelectedCustomer,
        shippingOptions, selectedOption, setSelectedOption,
        customAmount, setCustomAmount,
        openModal, closeModal, searchCustomers,
        handleSaveSalesChannel, handleSaveEmail, handleSaveShippingAddr, handleSaveBillingAddr,
        handleTransfer, handleSaveMetadata,
        patchOrder,
    } = modal_

    // ── Shipping ──────────────────────────────────────────────────────────────
    const [shippingSaving, setShippingSaving] = useState(false)
    const shipping = useOrderShipping({ id, setOrder, selectedOption, customAmount, saving: shippingSaving, setSaving: setShippingSaving, closeModal })
    const { handleAddShipping, handleRemoveShipping, handleReplaceShipping, handleUpdateShippingAmount } = shipping

    // ── Actions ───────────────────────────────────────────────────────────────
    const actions = useOrderActions({ id, order, estimateStatus, setEstimateStatus, patchOrder })
    const {
        converting, handleConvert, handleDelete,
        isConfirmingDelete, isDeleting, initiateDelete, cancelDelete,
        isConfirmingCancel, isCancelling, initiateCancel, cancelCancel, handleCancel,
        statusSaving, handleStatusChange,
        syncing, localRef, localTxnId, syncError, handleSync,
        metadataForm: actMetadataForm, setMetadataForm: actSetMetadataForm,
        metaNewKey: actMetaNewKey, setMetaNewKey: actSetMetaNewKey,
        metaNewVal: actMetaNewVal, setMetaNewVal: actSetMetaNewVal,
        handleAddMetaKey,
    } = actions

    return {
        // Order data
        order, loading, fetchError, fetchOrder,
        timeline, currentUser, addTimelineEvent,
        // QB
        syncing, localRef, localTxnId, syncError,
        // Estimate status
        estimateStatus, statusSaving,
        // Convert
        converting,
        // Modal
        modal, saving, shippingSaving, itemSaving, itemActionMap,
        salesChannels, selectedSc, setSelectedSc,
        emailForm, setEmailForm,
        shippingAddrForm, setShippingAddrForm,
        billingAddrForm, setBillingAddrForm,
        customerQuery, customers, selectedCustomer, setSelectedCustomer,
        shippingOptions, selectedOption, setSelectedOption,
        customAmount, setCustomAmount,
        invQuery, invResults,
        itemQtys, setItemQtys, itemPrices, setItemPrices,
        metadataForm: actMetadataForm, setMetadataForm: actSetMetadataForm,
        metaNewKey: actMetaNewKey, setMetaNewKey: actSetMetaNewKey,
        metaNewVal: actMetaNewVal, setMetaNewVal: actSetMetaNewVal,
        // Actions
        openModal, closeModal,
        searchCustomers, searchInvItems,
        handleSaveSalesChannel, handleSaveEmail, handleSaveShippingAddr, handleSaveBillingAddr,
        handleTransfer, handleAddItem, handleUpdateItem, handleRemoveItem,
        handleAddShipping, handleRemoveShipping, handleReplaceShipping, handleUpdateShippingAmount, handleSaveMetadata,
        handleDelete, handleConvert, handleStatusChange, handleSync, handleAddMetaKey, handleCancel,
        isConfirmingDelete, isDeleting, initiateDelete, cancelDelete,
        isConfirmingCancel, isCancelling, initiateCancel, cancelCancel,
    }
}

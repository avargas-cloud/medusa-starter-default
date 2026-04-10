import type { MedusaRequest, MedusaResponse } from "@medusajs/framework"
import { ContainerRegistrationKeys } from "@medusajs/utils"
import { writePipelineRow, pollUntilQbConfirmed } from "../../../../lib/quickbooks/qb-pipeline"
import { getEstimateTxnId, getEstimateRef } from "../../../../lib/quickbooks/qb-metadata-types"
import { buildQbItems, type MedusaOrderForQb } from "../../../../lib/quickbooks/order-flow-core"
import { parseSalesRepInitials } from "../../../../lib/quickbooks/parse-sales-rep"
import { withQbLock } from "../../../../lib/quickbooks/qb-locks"

export async function POST(req: MedusaRequest, res: MedusaResponse): Promise<void> {
    const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)
    const logger = req.scope.resolve("logger")
    const base = `http://localhost:${process.env.PORT ?? 9000}`
    const authHeaders: Record<string, string> = {
        "Cookie": String(req.headers["cookie"] ?? ""),
        "Authorization": String(req.headers["authorization"] ?? ""),
        "Content-Type": "application/json",
    }

    const {
        id, action, payload, items,
        shipping_option_id, shipping_price,
        promotion_code, promotion_id, order_discount,
        customer_id, customer_email
    } = req.body as any

    let resolvedId = id
    let cartId = null
    let displayId = null

    const localFetch = async (path: string, options: RequestInit) => {
        try {
            const r = await fetch(`${base}${path}`, { ...options, headers: authHeaders })
            if (!r.ok) {
                const txt = await r.text().catch(() => "")
                throw new Error(`[sync-pos] ${options.method} ${path} failed (${r.status}): ${txt}`)
            }
            return await r.json().catch(() => ({}))
        } catch (err: any) {
            logger.error(err.message)
            throw err
        }
    }

    try {
        if (action === "create") {
            // 0. Auto-resolve region
            let regionId: string | undefined
            const regRes = await localFetch("/admin/regions?limit=1", { method: "GET" }).catch(() => null)
            if (regRes?.regions?.length > 0) {
                 regionId = regRes.regions[0].id
                 payload.region_id = regionId
            }
        
            // 1. Create wrapper
            // IMPORTANT: Medusa native draft-orders endpoint ignores custom_description, sort_order, etc.
            // If we send payload.items, they are natively created with standard titles.
            // Then our loop below creates them AGAIN. Result: duplicated items!
            // Solution: Strip them from payload here, because the loop will create them perfectly.
            delete payload.items
            const createRes = await localFetch("/admin/draft-orders", { method: "POST", body: JSON.stringify(payload) })
            resolvedId = createRes.draft_order.id
            cartId = createRes.draft_order.cart_id
            displayId = createRes.draft_order.display_id

            // 2. Add Items
            for (const item of items) {
                await localFetch(`/admin/draft-orders/${resolvedId}/add-item-force`, {
                    method: "POST",
                    body: JSON.stringify({
                        variant_id: item.variantId,
                        quantity: item.quantity,
                        unit_price: item.effectiveUnitPrice,
                        line_discount: item.lineDiscount,
                        original_unit_price: item.lineDiscount ? item.unitPrice : null,
                        custom_title: item.title,
                        custom_description: item.salesDescription,
                        sort_order: item.sortOrder
                    })
                })
            }

            // 3. Shipping
            if (shipping_option_id) {
                await localFetch(`/admin/draft-orders/${resolvedId}/add-shipping-force`, {
                    method: "POST",
                    body: JSON.stringify({ shipping_option_id, custom_amount: shipping_price ?? 0 })
                }).catch(e => logger.warn(`Shipping force failed on create: ${e.message}`))
            }

            // 4. Promotions / Discounts
            if (promotion_code && promotion_id) {
                await localFetch("/admin/pos-discount/apply-existing", {
                    method: "POST",
                    body: JSON.stringify({ order_id: resolvedId, promotion_code, promotion_id })
                }).catch(e => logger.warn(`Promotion failed on create: ${e.message}`))
            } else if (promotion_code) {
                await localFetch("/admin/pos-discount", {
                    method: "POST",
                    body: JSON.stringify({
                        order_id: resolvedId,
                        discount_type: order_discount > 0 ? "fixed" : undefined,
                        discount_value: order_discount > 0 ? order_discount : undefined
                    })
                }).catch(e => logger.warn(`Discount failed on create: ${e.message}`))
            }

            // Write "waiting" pipeline row immediately so it appears in the QB Pipeline UI
            // (Medusa v2 does not emit draft_order.created — we must write this directly)
            if (process.env.QB_ORDER_FLOW_ENABLED === "true" && resolvedId) {
                const friendlyRef = displayId ? `E${displayId}` : null
                writePipelineRow({ orderId: resolvedId, step: "estimate", status: "waiting", medusaRefNumber: friendlyRef })
                    .catch(e => logger.warn(`[sync-pos] Could not write waiting pipeline row: ${e.message}`))
            }

        } else if (action === "update") {
            // 0. Handle Pos Transfer
            // Fetch the old order natively to ensure metadata isn't stripped by API projections
            let draftOrderModel: any = null
            try {
                const { data } = await query.graph({
                    entity: "order",
                    fields: ["id", "customer_id", "metadata", "display_id", "items.*", "cart.*"],
                    filters: { id: resolvedId }
                })
                draftOrderModel = data?.[0]
            } catch (e: any) {
                logger.warn(`Failed to fetch draft order natively: ${e.message}`)
            }

            if (customer_id && draftOrderModel?.customer_id && customer_id !== draftOrderModel.customer_id) {
                await localFetch(`/admin/pos-transfer`, {
                    method: "POST",
                    body: JSON.stringify({ id: resolvedId, customer_id, email: customer_email })
                }).catch(e => logger.warn(`Transfer failed: ${e.message}`))
            }

            // 1. Update Wrapper metadata
            const updateRes = await localFetch(`/admin/draft-orders/${resolvedId}`, {
                method: "POST", body: JSON.stringify(payload)
            })
            cartId = updateRes.draft_order?.cart_id

            const oldItems = draftOrderModel?.items ?? draftOrderModel?.cart?.items ?? []
            const newItems = items

            // 2. Delete missing items
            for (const old of oldItems) {
                if (!newItems.find((n: any) => n.localId === old.id)) {
                    await localFetch(`/admin/draft-orders/${resolvedId}/delete-item-force`, {
                        method: "POST", body: JSON.stringify({ line_item_id: old.id })
                    })
                }
            }

            // 3. Add or Update items
            let itemsChanged = false
            for (const item of newItems) {
                const existing = oldItems.find((o: any) => o.id === item.localId)
                if (existing) {
                    const changed =
                        item.effectiveUnitPrice !== (existing.unit_price ?? 0) ||
                        item.quantity !== (existing.quantity ?? 1) ||
                        (item.sortOrder !== undefined && item.sortOrder !== existing.metadata?.sort_order) ||
                        JSON.stringify(item.lineDiscount ?? null) !== JSON.stringify(existing.metadata?.line_discount ?? null) ||
                        item.unitPrice !== existing.metadata?.original_unit_price ||
                        item.priceListId !== (existing.metadata?.price_list_id ?? null) ||
                        item.priceListLabel !== (existing.metadata?.price_list_label ?? 'Default') ||
                        item.title !== existing.title ||
                        item.salesDescription !== existing.metadata?.sales_description

                    if (changed) {
                        await localFetch(`/admin/draft-orders/${resolvedId}/update-item-force`, {
                            method: "POST",
                            body: JSON.stringify({
                                line_item_id: existing.id,
                                quantity: item.quantity,
                                unit_price: item.effectiveUnitPrice,
                                ...(item.sortOrder !== undefined ? { sort_order: item.sortOrder } : {}),
                                line_discount: item.lineDiscount,
                                original_unit_price: item.unitPrice,
                                price_list_id: item.priceListId,
                                price_list_label: item.priceListLabel,
                                custom_title: item.title,
                                custom_description: item.salesDescription,
                            })
                        })
                        itemsChanged = true
                    }
                } else {
                    await localFetch(`/admin/draft-orders/${resolvedId}/add-item-force`, {
                        method: "POST",
                        body: JSON.stringify({
                            variant_id: item.variantId,
                            quantity: item.quantity,
                            unit_price: item.effectiveUnitPrice,
                            ...(item.sortOrder !== undefined ? { sort_order: item.sortOrder } : {}),
                            line_discount: item.lineDiscount,
                            original_unit_price: item.unitPrice,
                            price_list_id: item.priceListId,
                            price_list_label: item.priceListLabel,
                            custom_title: item.title,
                            custom_description: item.salesDescription,
                        })
                    })
                    itemsChanged = true
                }
            }

            // 4. Shipping sync
            const oldMethods = draftOrderModel?.shipping_methods ?? draftOrderModel?.cart?.shipping_methods ?? []
            const oldShippingId = oldMethods[0]?.shipping_option_id ?? null

            if (shipping_option_id !== oldShippingId || itemsChanged) {
                if (shipping_option_id) {
                    await localFetch(`/admin/draft-orders/${resolvedId}/add-shipping-force`, {
                        method: "POST", body: JSON.stringify({ shipping_option_id, custom_amount: shipping_price ?? 0 })
                    }).catch(e => logger.warn(`Update shipping failed: ${e.message}`))
                } else if (oldShippingId) {
                    await localFetch(`/admin/draft-orders/${resolvedId}/remove-shipping`, { method: "DELETE" })
                        .catch(e => logger.warn(`Remove shipping failed: ${e.message}`))
                }
            }

            // 5. Promo sync
            const savedPromoCode = draftOrderModel?.metadata?.promotion_code ?? null
            const currentPromoCode = promotion_code ?? null
            const promoNeedsSync = !!currentPromoCode || currentPromoCode !== savedPromoCode

            if (promoNeedsSync) {
                if (currentPromoCode) {
                    await localFetch("/admin/pos-discount/apply-existing", {
                        method: "POST", body: JSON.stringify({ order_id: resolvedId, promotion_code: currentPromoCode, promotion_id, expected_discount: order_discount })
                    }).catch(e => logger.warn(`Sync promotion failed: ${e.message}`))
                } else if (savedPromoCode) {
                    await localFetch("/admin/pos-discount", {
                        method: "DELETE", body: JSON.stringify({ order_id: resolvedId, promotion_code: savedPromoCode })
                    }).catch(e => logger.warn(`Remove promotion failed: ${e.message}`))
                }
            }

            // 5b. QuickBooks Pipeline hooks for Draft Orders (Estimates)
            logger.info(`[sync-pos] QB Flow Enabled: ${process.env.QB_ORDER_FLOW_ENABLED}, DraftOrder ID: ${resolvedId}`)
            if (process.env.QB_ORDER_FLOW_ENABLED === "true") {
                const qbTxnId = getEstimateTxnId(draftOrderModel?.metadata)
                logger.info(`[sync-pos] qbTxnId found: ${qbTxnId}`)
                if (qbTxnId) {
                    try {
                        const { updateEstimateInQb } = require("../../../../lib/quickbooks/client/estimates")

                        await localFetch(`/admin/draft-orders/${resolvedId}`, {
                            method: "POST",
                            body: JSON.stringify({ metadata: { qb_sync_status: "pending" } })
                        }).catch(() => {})

                        const medusaRef = draftOrderModel?.display_id ? `E${draftOrderModel.display_id}` : null
                        const qbRef = getEstimateRef(draftOrderModel?.metadata) ?? null

                        await writePipelineRow({
                            orderId: resolvedId,
                            step: "estimate",
                            status: "pending",
                            qbTxnId,
                            qbRefNumber: qbRef,
                            medusaRefNumber: medusaRef
                        }).catch((e: any) => logger.warn(`[sync-pos] Could not write pending pipeline row: ${e.message}`))

                        // Serialized per order via withQbLock.
                        // If save 2 arrives while save 1 is in-flight, save 2 waits until
                        // save 1 is CONFIRMED by the consolidator — so its fresh EditSequence
                        // is in the cache and save 2 can skip the QB GET round-trip entirely.
                        withQbLock(resolvedId, async () => {
                            const { data: [fullOrder] } = await query.graph({
                                entity: "order",
                                fields: ["*", "items.*", "items.variant.*", "items.variant.metadata", "customer.*", "shipping_methods.*"],
                                filters: { id: resolvedId }
                            })
                            if (!fullOrder) return

                            const typedOrder = fullOrder as unknown as MedusaOrderForQb
                            const qbItems = buildQbItems(typedOrder.items || [], typedOrder.metadata)
                            const memo = fullOrder.metadata?.document_number as string
                                || (fullOrder.display_id ? `E${fullOrder.display_id}` : qbTxnId)

                            const salesRep = parseSalesRepInitials(fullOrder.metadata?.sales_rep)
                            const result = await updateEstimateInQb({ txnId: qbTxnId, items: qbItems, memo, salesRep })
                            if (result.success) {
                                const rowId = await writePipelineRow({
                                    orderId: resolvedId,
                                    step: "estimate",
                                    status: "submitted",
                                    bridgeOpId: result.data?.operationId || null,
                                    qbTxnId,
                                    qbRefNumber: qbRef,
                                    medusaRefNumber: medusaRef
                                })
                                // Wait for the consolidator to confirm this operation (max 5 min).
                                // This ensures the next queued save picks up the fresh EditSequence
                                // from the cache rather than fetching from QB under a stale EditSequence.
                                const outcome = await pollUntilQbConfirmed(rowId)
                                if (outcome === "timeout") {
                                    logger.warn(`[sync-pos] QB estimate mod timed out waiting for confirmation (rowId=${rowId})`)
                                }
                            } else {
                                await writePipelineRow({
                                    orderId: resolvedId,
                                    step: "estimate",
                                    status: "failed",
                                    qbTxnId,
                                    qbRefNumber: qbRef,
                                    medusaRefNumber: medusaRef,
                                    error: result.error
                                })
                            }
                        })
                    } catch (qbErr: any) {
                        logger.error(`[sync-pos] Failed to queue QB sync for modified estimate: ${qbErr.message}`)
                    }
                }
            }
        }

        // 6. Compute Tax Always (Fire & Forget / Sequential is fine locally)
        await localFetch(`/admin/draft-orders/${resolvedId}/compute-tax`, { method: "GET" })
            .catch(() => {})

        res.status(200).json({ success: true, draft_order_id: resolvedId, cart_id: cartId, display_id: displayId })

    } catch (e: any) {
        logger.error(`[sync-pos] Master sync failed: ${e.message}`)
        res.status(500).json({ success: false, message: e.message })
    }
}

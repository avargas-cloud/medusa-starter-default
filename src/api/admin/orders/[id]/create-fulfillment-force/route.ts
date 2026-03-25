import type { MedusaRequest, MedusaResponse } from "@medusajs/framework"
import { createReservationsWorkflow } from "@medusajs/core-flows"
import { Modules } from "@medusajs/utils"
import { getDbPool } from "../../../../utils/db-pool"

/**
 * POST /admin/orders/:id/create-fulfillment-force
 *
 * Creates a fulfillment for a POS local-pickup order.
 *
 * Strategy 1 (native, preferred): createOrderFulfillmentWorkflow
 *   Pre-steps (before calling native workflow):
 *     A) SQL: set requires_shipping=false on order_item rows
 *        (bypasses Medusa's shipping-profile check for local pickup)
 *     B) Ensure stock reservations exist for each item
 *        (POS orders bypass checkout so reservations are never auto-created;
 *         the native workflow requires them to exist before fulfilling)
 *   Falls through to Strategy 2 only if this still fails (e.g. 0-stock items
 *   where reservation creation itself is rejected).
 *
 * Strategy 2 (force, fallback): FulfillmentModuleService + OrderModuleService
 *   Post-step: SQL sets fulfilled_quantity=quantity on ALL order_item rows
 *   to fix fulfillment_status display when order has historical item versions.
 *
 * Body:
 *   items: { id: string; quantity: number }[]
 *   location_id: string
 *   no_notification?: boolean
 */
export async function POST(req: MedusaRequest, res: MedusaResponse) {
    const { id } = req.params
    const { items, location_id, invoice_id, no_notification = true } = req.body as {
        items: { id: string; quantity: number }[]
        location_id: string
        invoice_id?: string
        no_notification?: boolean
    }

    if (!items?.length || !location_id) {
        return res.status(400).json({ message: "items and location_id are required" })
    }

    const orderId = id as string
    const dbUrl = process.env.DATABASE_URL
    const pool = dbUrl ? getDbPool() : null

    async function bindFulfillmentToInvoice(fulfillmentId: string, invId: string) {
        if (!pool || !fulfillmentId || !invId) return
        try {
            await pool.query(
                `UPDATE pos_invoice SET fulfillment_id = $1 WHERE id = $2`,
                [fulfillmentId, invId]
            )
            console.log(`[create-fulfillment-force] ✅ Bound fulfillment ${fulfillmentId} to Invoice ${invId}`)

            // Feature Upgrade: inherit QB ref from invoice metadata onto the new fulfillment metadata
            try {
                const invRes = await pool.query(`SELECT metadata FROM pos_invoice WHERE id = $1`, [invId])
                const invMeta = invRes.rows[0]?.metadata || {}
                
                if (invMeta.qb_txn_id) {
                    const fulfillmentModule = req.scope.resolve(Modules.FULFILLMENT) as any
                    const fRes = await fulfillmentModule.retrieveFulfillment(fulfillmentId)
                    await fulfillmentModule.updateFulfillment(fulfillmentId, {
                        metadata: {
                            ...(fRes.metadata || {}),
                            qb_txn_id: invMeta.qb_txn_id,
                            qb_ref_number: invMeta.qb_ref_number
                        }
                    })
                    console.log(`[create-fulfillment-force] ✅ Copied QB Ref ${invMeta.qb_ref_number} onto Medusa Fulfillment ${fulfillmentId}`)
                }
            } catch (metaErr: any) {
                console.warn(`[create-fulfillment-force] Failed to inherit QB meta to fulfillment: ${metaErr?.message}`)
            }

        } catch (err: any) {
            console.warn(`[create-fulfillment-force] Failed to bind to pos_invoice: ${err?.message}`)
        }
    }

    // ── Strategy 1: Native createOrderFulfillmentWorkflow ────────────────────
    try {
        const { createOrderFulfillmentWorkflow } = await import("@medusajs/core-flows")
        console.log(`[create-fulfillment-force] 🔄 Strategy 1: native workflow for order=${orderId}`)

        if (dbUrl) {
            const pool = getDbPool()
            try {
                // Pre-step A: Set requires_shipping=false via SQL
                // orderModule.updateOrderItem() fails silently for this field.
                // Raw SQL is the reliable path for local pickup items.
                const itemIds = items.map((i: any) => i.id)
                await pool.query(
                    `UPDATE order_line_item SET requires_shipping = false WHERE id = ANY($1)`,
                    [itemIds]
                )
                console.log(`[create-fulfillment-force] ✅ Pre-A: requires_shipping=false for ${itemIds.length} items`)

                // Pre-step B: Ensure stock reservations exist for each item.
                // POS orders call allocate-items at save time, but this is the safety net.
                // POS uses allow_backorder=true → createReservationItems always succeeds
                // regardless of stocked_quantity. No stock bump needed.
                const inventoryModule = req.scope.resolve(Modules.INVENTORY) as any

                for (const reqItem of items) {
                    try {
                        // Idempotent: reqItem.id is order_line_item.id (from Medusa API)
                        const existing = await inventoryModule.listReservationItems(
                            { line_item_id: reqItem.id },
                            { take: 1 }
                        )
                        if (existing?.length) {
                            console.log(`[create-fulfillment-force] ✅ Pre-B: reservation exists for item ${reqItem.id}`)
                            continue
                        }

                        // reqItem.id = order_line_item.id → join via oi.item_id to get variant_id
                        const variantRes = await pool.query<{ variant_id: string | null }>(
                            `SELECT oli.variant_id
                             FROM order_line_item oli
                             WHERE oli.id = $1 LIMIT 1`,
                            [reqItem.id]
                        )
                        const variantId = variantRes.rows[0]?.variant_id
                        if (!variantId) {
                            console.warn(`[create-fulfillment-force] Pre-B: no variant_id for item ${reqItem.id}, skipping`)
                            continue
                        }

                        // Get inventory_item_id from variant→inventory link table
                        const invItemRes = await pool.query<{ inventory_item_id: string }>(
                            `SELECT inventory_item_id FROM product_variant_inventory_item
                             WHERE variant_id = $1 AND deleted_at IS NULL LIMIT 1`,
                            [variantId]
                        )
                        const inventoryItemId = invItemRes.rows[0]?.inventory_item_id
                        if (!inventoryItemId) {
                            console.warn(`[create-fulfillment-force] Pre-B: no inventory_item for variant ${variantId}, skipping`)
                            continue
                        }

                        // Use native createReservationsWorkflow — reqItem.id IS order_line_item.id ✅
                        await createReservationsWorkflow(req.scope).run({
                            input: {
                                reservations: [{
                                    inventory_item_id: inventoryItemId,
                                    location_id,
                                    quantity: reqItem.quantity,
                                    line_item_id: reqItem.id,
                                }],
                            },
                        })
                        console.log(`[create-fulfillment-force] ✅ Pre-B: created reservation for item ${reqItem.id} (inv=${inventoryItemId})`)

                    } catch (reservErr: any) {
                        // Non-fatal: fall through to Strategy 2 if this fails
                        console.warn(`[create-fulfillment-force] Pre-B: reservation failed for ${reqItem.id}: ${reservErr?.message?.slice(0, 80)}`)
                    }
                }

            } finally {
                // shared pool — do NOT call pool.end()
            }
        }

        // Call the native workflow — should succeed now that reservations exist
        const result = await createOrderFulfillmentWorkflow(req.scope).run({
            input: {
                order_id: orderId,
                items,
                location_id,
                no_notification,
                created_by: ((req as any).auth_context?.actor_id ?? "") as string,
            },
        }).catch(err => {
            require('fs').writeFileSync('/home/alejo/webapps/ecopowertech-workspace/tmp-strategy1-error.txt', err.message + '\n' + err.stack)
            throw err
        })

        // ── fulfilled_quantity fix (Strategy 1) ──────────────────────────
        // Only safely increment the items that were just fulfilled
        if (dbUrl && items.length > 0) {
            const pool = getDbPool()
            try {
                for (const item of items) {
                    await pool.query(
                        `UPDATE order_item
                         SET fulfilled_quantity = LEAST(quantity, COALESCE(fulfilled_quantity, 0) + $1::numeric)
                         WHERE id = $2`,
                        [item.quantity, item.id]
                    )
                }
                console.log(`[create-fulfillment-force] ✅ Patched fulfilled_quantity for ${items.length} order_item rows (Strategy 1)`)
            } catch (sqlErr: any) {
                console.warn(`[create-fulfillment-force] fulfilled_quantity patch failed (non-fatal): ${sqlErr?.message}`)
            }
        }

        console.log(`[create-fulfillment-force] ✅ Strategy 1 (native workflow) succeeded`)
        const returnedFulfillment = (result.result as any) ?? { id: "ok" }
        if (invoice_id && returnedFulfillment.id !== "ok") {
            await bindFulfillmentToInvoice(returnedFulfillment.id, invoice_id)
        }
        return res.status(201).json({ fulfillment: returnedFulfillment })

    } catch (workflowErr: any) {
        console.warn(`[create-fulfillment-force] ⚠️ Strategy 1 failed (${workflowErr?.message?.slice(0, 100)}), falling back to Strategy 2...`)
    }


    // ── Strategy 2: FulfillmentModule + OrderModule directly (force path) ─────
    try {
        const orderModule = req.scope.resolve(Modules.ORDER) as any
        const fulfillmentModule = req.scope.resolve(Modules.FULFILLMENT) as any

        const orderData = await orderModule.retrieveOrder(orderId, {
            relations: ["items", "shipping_address", "shipping_methods"],
        })

        const shippingMethod = orderData?.shipping_methods?.[0]

        const fulfillmentItems = items.map((reqItem: { id: string; quantity: number }) => {
            const orderItem = orderData?.items?.find((i: any) => i.id === reqItem.id)
            const sku = orderItem?.variant_sku ?? orderItem?.sku ?? null
            const barcode = orderItem?.variant_barcode ?? sku ?? ''
            return {
                title: orderItem?.title ?? 'Item',
                sku,
                barcode,
                quantity: reqItem.quantity,
                line_item_id: reqItem.id,
            }
        })

        console.log(`[create-fulfillment-force] 🔄 Strategy 2: module services, items=${fulfillmentItems.length}`)

        // Try providers in priority order
        const dbProviders: string[] = []
        try {
            const rows = await fulfillmentModule.listFulfillmentProviders({}, { take: 20 })
            dbProviders.push(...(rows as any[]).map((p: any) => p.id).filter(Boolean))
        } catch { /* non-fatal */ }

        const optionProvider = shippingMethod?.shipping_option?.provider_id
        const candidates = [...new Set([
            'store-pickup_store-pickup',
            'manual_manual',
            optionProvider,
            ...dbProviders,
        ].filter(Boolean))] as string[]
        console.log(`[create-fulfillment-force] Provider candidates (${candidates.length}):`, candidates.slice(0, 4))

        let fulfillment: any

        const deliveryAddress = (orderData?.shipping_address?.country_code)
            ? (() => {
                const { id, created_at, updated_at, deleted_at, ...clean } = orderData.shipping_address as any
                return clean
            })()
            : { address_1: '2760 W 84th St Unit 4', city: 'Hialeah', province: 'FL', postal_code: '33016', country_code: 'us' }

        for (const providerId of candidates) {
            try {
                fulfillment = await fulfillmentModule.createFulfillment({
                    location_id,
                    provider_id: providerId,
                    shipping_option_id: shippingMethod?.shipping_option_id ?? null,
                    items: fulfillmentItems,
                    delivery_address: deliveryAddress,
                    order: { id: orderId },
                    data: {},
                    labels: [],
                })
                console.log(`[create-fulfillment-force] ✅ Created with provider=${providerId}: ${fulfillment.id}`)
                break
            } catch (err: any) {
                console.warn(`[create-fulfillment-force] provider=${providerId} failed: ${err?.message?.slice(0, 80)}`)
            }
        }

        if (!fulfillment) {
            try {
                fulfillment = await fulfillmentModule.createFulfillment({
                    location_id,
                    shipping_option_id: shippingMethod?.shipping_option_id ?? null,
                    items: fulfillmentItems,
                    delivery_address: deliveryAddress,
                    order: { id: orderId },
                    data: {},
                    labels: [],
                })
                console.log(`[create-fulfillment-force] ✅ Created (no provider): ${fulfillment.id}`)
            } catch (err: any) {
                throw new Error(`All provider attempts failed. Last error: ${err?.message}`)
            }
        }

        // Register fulfillment against the order
        try {
            await orderModule.registerFulfillment({
                order_id: orderId,
                reference: "fulfillment",
                reference_id: fulfillment.id,
                items: items.map((i: { id: string; quantity: number }) => ({
                    id: i.id,
                    quantity: i.quantity,
                })),
            })
            console.log(`[create-fulfillment-force] ✅ Fulfillment registered against order`)
        } catch (regErr: any) {
            console.warn(`[create-fulfillment-force] registerFulfillment warning: ${regErr?.message?.slice(0, 100)}`)
        }

        // ── fulfilled_quantity fix (Strategy 2 only) ──────────────────────────
        // Only safely increment the items that were just fulfilled
        if (dbUrl && items.length > 0) {
            const pool2 = getDbPool()
            try {
                for (const item of items) {
                    await pool2.query(
                        `UPDATE order_item
                         SET fulfilled_quantity = LEAST(quantity, COALESCE(fulfilled_quantity, 0) + $1::numeric)
                         WHERE id = $2`,
                        [item.quantity, item.id]
                    )
                }
                console.log(`[create-fulfillment-force] ✅ Patched fulfilled_quantity for ${items.length} order_item rows`)
            } catch (sqlErr: any) {
                console.warn(`[create-fulfillment-force] fulfilled_quantity patch failed (non-fatal): ${sqlErr?.message}`)
            }
        }

        if (invoice_id && fulfillment?.id) {
            await bindFulfillmentToInvoice(fulfillment.id, invoice_id)
        }

        return res.status(201).json({ fulfillment })

    } catch (moduleErr: any) {
        console.error(`[create-fulfillment-force] ❌ Strategy 2 also failed: ${moduleErr?.message}`)
        return res.status(500).json({ message: moduleErr?.message ?? "Fulfillment creation failed" })
    }
}

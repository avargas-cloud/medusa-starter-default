import type { MedusaRequest, MedusaResponse } from "@medusajs/framework"
import { createReservationsWorkflow } from "@medusajs/core-flows"
import { Modules } from "@medusajs/utils"

/**
 * POST /admin/orders/:id/allocate-items
 *
 * Creates stock reservations for POS order items that don't have them.
 * Called at ORDER SAVE / EDIT time (and as safety net during invoice creation).
 *
 * Uses ONLY Medusa module APIs — NO raw pg.Pool (which competes with
 * Railway DB connection limits). All queries go through Medusa's shared ORM.
 *
 * Body:
 *   location_id?: string  — if omitted, uses first available stock location
 */
export async function POST(req: MedusaRequest, res: MedusaResponse) {
    const { id: orderId } = req.params
    let { location_id } = req.body as { location_id?: string }

    const base = `http://localhost:${process.env.PORT ?? 9000}`
    const authHeaders = {
        "Cookie": String(req.headers["cookie"] ?? ""),
        "Authorization": String(req.headers["authorization"] ?? ""),
    }

    const results: { line_item_id: string; status: string; reservation_id?: string; reason?: string }[] = []

    try {
        const inventoryModule = req.scope.resolve(Modules.INVENTORY) as any
        const remoteQuery = req.scope.resolve("remoteQuery") as any

        // 1. Get location_id from request body or first available stock location
        if (!location_id) {
            const stockLocationModule = req.scope.resolve(Modules.STOCK_LOCATION) as any
            const locs = await stockLocationModule.listStockLocations({}, { take: 1, select: ["id"] })
            location_id = locs?.[0]?.id
            if (!location_id) {
                return res.status(200).json({ allocated: [], message: "No stock location found" })
            }
        }

        // 2. Get order items via Medusa admin API (internal HTTP — uses Medusa ORM, not new Pool)
        //    order.items[].id = order_line_item.id (correct line_item_id for reservations)
        const orderRes = await fetch(
            `${base}/admin/orders/${orderId}?fields=id,+items.id,+items.quantity,+items.variant_id`,
            { headers: authHeaders }
        )
        if (!orderRes.ok) {
            return res.status(400).json({ error: `Cannot fetch order: ${orderRes.status}` })
        }
        const { order } = await orderRes.json()
        const orderItems: { id: string; quantity: number; variant_id: string | null }[] = order?.items ?? []

        if (!orderItems.length) {
            return res.status(200).json({ allocated: [], message: "No items found" })
        }

        // 3. For each order item, look up inventory_item_id and create reservation.
        //    Per-item lookup so a single DB error doesn't silently skip other items.
        for (const item of orderItems) {
            const lineItemId = item.id  // order_line_item.id ✅
            const quantity = Number(item.quantity)
            const variantId = item.variant_id

            if (!variantId) {
                results.push({ line_item_id: lineItemId, status: "skipped", reason: "no variant_id (custom item?)" })
                continue
            }

            try {
                let existingResId: string | undefined

                // Idempotent: check by order_line_item.id
                const existing = await inventoryModule.listReservationItems(
                    { line_item_id: lineItemId },
                    { take: 1 }
                )
                if (existing?.length) {
                    if (Number(existing[0].quantity) === quantity) {
                        results.push({ line_item_id: lineItemId, status: "already_allocated", reservation_id: existing[0].id })
                        continue
                    } else {
                        existingResId = existing[0].id
                        console.log(`[allocate-items] 📝 Quantity changed for ${lineItemId}: ${existing[0].quantity} -> ${quantity}`)
                    }
                }

                // Get inventory_item_id per variant via remoteQuery
                // Using correct Medusa v2 syntax for filtering (not $where)
                let inventoryItemId: string | undefined
                try {
                    const variantData = await remoteQuery({
                        variant: {
                            fields: ["id", "manage_inventory"],
                            __args: { filters: { id: variantId } },
                            inventory_items: { fields: ["inventory_item_id"] }
                        }
                    })
                    inventoryItemId = variantData?.[0]?.inventory_items?.[0]?.inventory_item_id
                } catch (qErr: any) {
                    console.warn(`[allocate-items] remoteQuery lookup failed for variant ${variantId}: ${qErr.message?.slice(0, 80)}`)
                }

                if (!inventoryItemId) {
                    results.push({ line_item_id: lineItemId, status: "skipped", reason: "no inventory_item (unmanaged product)" })
                    continue
                }

                // Guard 1: Ensure allow_backorder=true (POS items must reserve regardless of stock).
                // Does NOT change stocked_quantity — only the backorder policy.
                try {
                    const [invItem] = await inventoryModule.listInventoryItems(
                        { id: inventoryItemId },
                        { select: ["id", "allow_backorder"] }
                    )
                    if (invItem && !invItem.allow_backorder) {
                        await inventoryModule.updateInventoryItems([{ id: inventoryItemId, allow_backorder: true }])
                        console.log(`[allocate-items] ✅ Enabled allow_backorder for ${inventoryItemId}`)
                    }
                } catch (boErr: any) {
                    console.warn(`[allocate-items] allow_backorder check failed: ${boErr.message?.slice(0, 80)}`)
                }

                // Guard 2: Ensure an inventory level exists at this location.
                // createReservationsWorkflow needs a level row to update reserved_quantity,
                // even when allow_backorder=true. Creates level (stocked_quantity=0) if missing.
                try {
                    const levels = await inventoryModule.listInventoryLevels(
                        { inventory_item_id: inventoryItemId, location_id },
                        { select: ["id"] }
                    )
                    if (!levels?.length) {
                        await inventoryModule.createInventoryLevels([{
                            inventory_item_id: inventoryItemId,
                            location_id,
                            stocked_quantity: 0,
                        }])
                        console.log(`[allocate-items] ➕ Created inventory level (stock=0) for ${inventoryItemId} at ${location_id}`)
                    }
                } catch (levelErr: any) {
                    console.warn(`[allocate-items] Level check failed for ${inventoryItemId}: ${levelErr.message?.slice(0, 80)}`)
                }

                if (existingResId) {
                    try {
                        const { updateReservationsWorkflow } = require("@medusajs/core-flows")
                        if (updateReservationsWorkflow) {
                            await updateReservationsWorkflow(req.scope).run({
                                input: { updates: [{ id: existingResId, quantity }] }
                            })
                        } else {
                            await inventoryModule.updateReservationItems(existingResId, { quantity })
                        }
                    } catch (e) {
                        await inventoryModule.updateReservationItems([{ id: existingResId, quantity }]).catch(() => {})
                    }
                    results.push({ line_item_id: lineItemId, status: "updated_allocation", reservation_id: existingResId })
                    console.log(`[allocate-items] 🔄 Updated reservation ${existingResId} to ${quantity}×`)
                } else {
                    // Create reservation — succeeds even at 0 stock (allow_backorder=true + level exists)
                    const { result } = await createReservationsWorkflow(req.scope).run({
                        input: {
                            reservations: [{
                                inventory_item_id: inventoryItemId,
                                location_id,
                                quantity,
                                line_item_id: lineItemId,
                                allow_backorder: true // Bypass 0 stock validation
                            }],
                        },
                    })
                    const reservation = result?.[0]
                    results.push({ line_item_id: lineItemId, status: "allocated", reservation_id: reservation?.id })
                    console.log(`[allocate-items] ✅ Reserved ${quantity}× variant=${variantId} → ${reservation?.id}`)
                }

            } catch (err: any) {
                console.warn(`[allocate-items] Failed for ${lineItemId}: ${err?.message?.slice(0, 120)}`)
                results.push({ line_item_id: lineItemId, status: "error", reason: err?.message?.slice(0, 120) })
            }
        }


        return res.status(200).json({ allocated: results })

    } catch (err: any) {
        console.error(`[allocate-items] Fatal: ${err?.message}`)
        return res.status(500).json({ error: err?.message })
    }
}

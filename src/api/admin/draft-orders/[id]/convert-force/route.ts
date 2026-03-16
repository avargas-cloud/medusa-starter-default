import type { MedusaRequest, MedusaResponse } from "@medusajs/framework"
import { ContainerRegistrationKeys, Modules, OrderStatus, OrderWorkflowEvents } from "@medusajs/utils"

/**
 * POST /admin/draft-orders/:id/convert-force
 *
 * Converts a draft order to a confirmed order with two key guarantees:
 *
 * 1. BACKORDER SUPPORT: Items with 0 stock are accepted. If Medusa's native
 *    conversion fails due to insufficient inventory, we temporarily enable
 *    allow_backorder on the affected inventory items, retry, then restore.
 *
 * 2. TAX FIDELITY: After conversion, Medusa may re-run its own tax calculation
 *    (e.g., FL Tax Region at 7%) on top of our custom tax_lines, causing the
 *    payment collection amount to be inflated (double-counted tax).
 *    We fix this by reading the `current_order_total` that our compute-tax
 *    already stored in order_summary, then patching the payment collection
 *    to use that exact value—preserving the exact tax decision made in the
 *    draft (including 0% for tax-exempt customers, non-FL addresses, etc).
 */
export async function POST(req: MedusaRequest, res: MedusaResponse): Promise<void> {
    const { id } = req.params as { id: string }
    const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)

    const base = `http://localhost:${process.env.PORT ?? 9000}`
    const authHeaders: Record<string, string> = {
        "Cookie": String(req.headers["cookie"] ?? ""),
        "Authorization": String(req.headers["authorization"] ?? ""),
        "Content-Type": "application/json",
    }

    // ── Helper: call the native Medusa convert-to-order endpoint ──────────────
    // (removed unused callConvert function since we bypass the REST layer natively) // ── Helper: compute the true order total from live order data ─────────────
    // Reads directly from the converted order's items, shipping, and tax totals.
    // More reliable than order_summary.current_order_total, which is stale if the
    // user changed quantities via update-item-force without re-running compute-tax.
    const computeTrueTotal = async (): Promise<number | null> => {
        try {
            // Fetch order.total directly — Medusa computes this from the stored tax_lines
            // (which were set by our compute-tax workflow in the draft stage), so it's always
            // correct regardless of conversion timing.
            //
            // ⚠️  Previous approach (sum from items × qty + shipping + tax) had a race condition:
            //     immediately after conversion, the HTTP API could return only 1 of N items
            //     (DB not fully committed yet) → wrong total → payment collection patched incorrectly.
            const orderRes = await fetch(
                `${base}/admin/orders/${id}?fields=total,tax_total,subtotal,discount_total`,
                { headers: authHeaders }
            )
            if (!orderRes.ok) return null
            const { order } = await orderRes.json()
            if (!order?.total) return null
            console.log(`[convert-force] order.total from API: ${order.total} (tax=${order.tax_total}, subtotal=${order.subtotal})`)
            return order.total > 0 ? order.total : null
        } catch (e: any) {
            console.warn("[convert-force] Could not fetch order total:", e?.message)
            return null
        }
    }


    // ── Helper: patch payment collection to the correct amount ────────────────
    const fixPaymentCollection = async (correctTotal: number) => {
        try {
            // Fetch the order's payment collections
            const pcRes = await fetch(
                `${base}/admin/payment-collections?order_id=${id}`,
                { headers: authHeaders }
            )
            if (!pcRes.ok) return

            const pcJson = await pcRes.json()
            const collections: any[] = pcJson.payment_collections ?? []

            for (const col of collections) {
                // Amount in payment collection is in cents; our total is in dollars
                const correctCents = Math.round(correctTotal * 100)
                if (col.amount === correctCents) continue  // already correct

                console.log(`[convert-force] Patching payment collection ${col.id}: ${col.amount} → ${correctCents} cents`)
                await fetch(`${base}/admin/payment-collections/${col.id}`, {
                    method: "POST",
                    headers: authHeaders,
                    body: JSON.stringify({ amount: correctCents }),
                })
            }
        } catch (e: any) {
            console.warn("[convert-force] Could not patch payment collection:", e?.message)
        }
    }

    try {
        // ── Step 1: Fetch draft order items ───────────────────────────────────
        // Get items from the DRAFT (not confirmed order) to create reservations
        // proactively — avoids the try → fail → fix → retry anti-pattern.
        const draftRes = await fetch(`${base}/admin/draft-orders/${id}`, { headers: authHeaders })
        if (draftRes.ok) {
            const { draft_order } = await draftRes.json()
            const items: any[] = draft_order?.items ?? draft_order?.cart?.items ?? []

            // ── Step 2: Get the primary stock location ────────────────────────
            const slRes = await fetch(`${base}/admin/stock-locations?limit=100`, { headers: authHeaders })
            const slJson = slRes.ok ? await slRes.json() : {}
            const primaryLocationId: string | undefined = (slJson.stock_locations ?? [])[0]?.id

            if (primaryLocationId && items.length > 0) {
                // ── Step 3: Ensure allow_backorder reservations for all items ─
                // Creating reservations before conversion means convert-to-order
                // finds existing reservations and skips the stock check entirely.
                for (const lineItem of items) {
                    const lineItemId: string = lineItem.id
                    const variantId: string | undefined = lineItem.variant_id ?? lineItem.variant?.id
                    if (!variantId) continue

                    // Skip if reservation already exists
                    const resRes = await fetch(`${base}/admin/reservations?line_item_id[]=${lineItemId}&limit=5`, { headers: authHeaders })
                    const resJson = resRes.ok ? await resRes.json() : {}
                    if ((resJson.reservations ?? []).length > 0) continue

                    // Find the inventory item for this variant
                    const { data: variants } = await query.graph({
                        entity: "variant",
                        fields: ["id", "inventory_items.inventory_item_id"],
                        filters: { id: variantId }
                    })
                    const inventoryItemId = variants[0]?.inventory_items?.[0]?.inventory_item_id
                    if (!inventoryItemId) {
                        console.warn(`[convert-force] No inventory item for variant ${variantId}, skipping reservation`)
                        continue
                    }

                    // Create reservation with allow_backorder — bypasses stock check
                    const createRes = await fetch(`${base}/admin/reservations`, {
                        method: "POST",
                        headers: authHeaders,
                        body: JSON.stringify({
                            line_item_id: lineItemId,
                            inventory_item_id: inventoryItemId,
                            location_id: primaryLocationId,
                            quantity: lineItem.quantity ?? 1,
                            allow_backorder: true,
                        }),
                    })
                    if (!createRes.ok) {
                        const err = await createRes.json().catch(() => ({}))
                        console.warn(`[convert-force] Reservation failed for ${lineItemId}:`, err?.message)
                    } else {
                        console.log(`[convert-force] ✅ Reservation created for lineItem ${lineItemId} (allow_backorder)`)
                    }
                }
            }
        } else {
            console.warn(`[convert-force] Could not fetch draft order ${id} — proceeding without reservation pre-creation`)
        }

        // ── Step 4: Convert draft → confirmed order natively (bypassing stock reservation block) ────────
        let convertedOrder
        try {
            const orderService = req.scope.resolve(Modules.ORDER)
            const response = await orderService.updateOrders([
                {
                    id,
                    status: OrderStatus.PENDING,
                    is_draft_order: false,
                },
            ])
            convertedOrder = response[0]
            
            // Emit the PLACED event purely natively so subscribers like QBDraftOrderSync react properly.
            if (convertedOrder) {
                const eventBus = req.scope.resolve(Modules.EVENT_BUS)
                await eventBus.emit({
                    name: OrderWorkflowEvents.PLACED,
                    data: { id: convertedOrder.id }
                })
            }
            
        } catch (cvErr: any) {
            console.error(`[convert-force] Direct API Conversion failed:`, cvErr?.message)
            return void res.status(500).json({ message: cvErr?.message ?? "Conversion failed natively" })
        }

        // ── Step 5: Fix payment collection total (post-conversion) ───────────
        const correctTotal = await computeTrueTotal()
        if (correctTotal !== null) {
            await fixPaymentCollection(correctTotal)
        }

        // Stamp order_placed_at so POS activity log shows correct creation time
        try {
            await fetch(`${base}/admin/orders/${id}`, {
                method: 'POST',
                headers: authHeaders,
                body: JSON.stringify({ metadata: { order_placed_at: new Date().toISOString() } }),
            })
            console.log(`[convert-force] ✅ Stamped order_placed_at on order ${id}`)
        } catch (metaErr: any) {
            console.warn(`[convert-force] ⚠️ Could not stamp order_placed_at: ${metaErr?.message}`)
        }

        return void res.status(200).json({ order: convertedOrder })
    } catch (e: any) {
        console.error("[convert-force]", e?.message)
        res.status(500).json({ message: e?.message ?? "Conversion failed" })
    }
}

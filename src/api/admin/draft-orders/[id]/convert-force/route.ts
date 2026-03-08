import type { MedusaRequest, MedusaResponse } from "@medusajs/framework"

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

    const base = `http://localhost:${process.env.PORT ?? 9000}`
    const authHeaders: Record<string, string> = {
        "Cookie": String(req.headers["cookie"] ?? ""),
        "Authorization": String(req.headers["authorization"] ?? ""),
        "Content-Type": "application/json",
    }

    // ── Helper: call the native Medusa convert-to-order endpoint ──────────────
    const callConvert = () =>
        fetch(`${base}/admin/draft-orders/${id}/convert-to-order`, {
            method: "POST",
            headers: authHeaders,
        })

    // ── Helper: compute the true order total from live order data ─────────────
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
        // ── Step 1: Try standard conversion first ─────────────────────────────
        let cvRes = await callConvert()
        let cvJson = await cvRes.json()

        if (cvRes.ok) {
            // Compute the true total from the order AFTER conversion
            const correctTotal = await computeTrueTotal()
            if (correctTotal !== null) {
                await fixPaymentCollection(correctTotal)
            }

            // Save the exact conversion timestamp — Medusa may inherit created_at from the
            // cart (draft order creation date), so we stamp order_placed_at explicitly.
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

            // The order.placed event is emitted by Medusa's conversion workflow and
            // picked up by qb-order-subscriber.ts, which creates the QB Sales Order.
            // ⚠️  Do NOT call /admin/quickbooks/order here — that would create a duplicate SO.

            return void res.status(200).json(cvJson)
        }

        // ── Step 2: Check if it's an inventory error ──────────────────────────
        const isInventoryError =
            cvJson?.type === "not_allowed" ||
            (cvJson?.message ?? "").toLowerCase().includes("insufficient") ||
            (cvJson?.message ?? "").toLowerCase().includes("inventory") ||
            (cvJson?.message ?? "").toLowerCase().includes("stock")

        if (!isInventoryError) {
            return void res.status(cvRes.status).json(cvJson)
        }

        console.log(`[convert-force] Inventory error for ${id}. Creating missing reservations via native API…`)

        // ── Step 3: Create missing inventory RESERVATIONS for line items ─────────
        //
        // Items added via add-item-force skip Medusa's normal flow and never get
        // inventory reservations created. Medusa's conversion workflow REQUIRES
        // reservations to exist in order to confirm them.
        //
        // With allow_backorder=true (set globally), reservations can be created
        // even at 0 or negative stock — we are NOT changing stock quantities.
        //
        // Process:
        //  a) Get the order's line items and the default stock location
        //  b) For each line item, check if a reservation already exists
        //  c) If not, find the inventory item for that variant via native API
        //  d) Create the reservation (soft allocation, no stock change)

        const orderRes = await fetch(`${base}/admin/orders/${id}?fields=+items.*`, { headers: authHeaders })
        if (!orderRes.ok) return void res.status(cvRes.status).json(cvJson)
        const { order } = await orderRes.json()
        const items: any[] = order?.items ?? []

        // Get stock locations to know where to create reservations
        const slRes = await fetch(`${base}/admin/stock-locations?limit=100`, { headers: authHeaders })
        const slJson = slRes.ok ? await slRes.json() : {}
        const stockLocations: any[] = slJson.stock_locations ?? []
        const primaryLocationId: string | undefined = stockLocations[0]?.id
        if (!primaryLocationId) {
            console.warn("[convert-force] No stock locations found, skipping reservation creation")
        }

        if (primaryLocationId) {
            for (const lineItem of items) {
                const lineItemId: string = lineItem.id
                const variantId: string | undefined = lineItem.variant_id ?? lineItem.variant?.id
                if (!variantId) continue

                // a) Check if a reservation already exists for this line item
                const resRes = await fetch(`${base}/admin/reservations?line_item_id[]=${lineItemId}&limit=5`, { headers: authHeaders })
                const resJson = resRes.ok ? await resRes.json() : {}
                const existingRes: any[] = resJson.reservations ?? []
                if (existingRes.length > 0) continue // already has a reservation

                // b) Find inventory item for this variant via the native API
                const invRes = await fetch(`${base}/admin/inventory-items?variant_id[]=${variantId}&limit=10`, { headers: authHeaders })
                if (!invRes.ok) continue
                const invJson = await invRes.json()
                const invItems: any[] = invJson.inventory_items ?? []
                if (invItems.length === 0) {
                    console.warn(`[convert-force] No inventory item found for variant ${variantId}, skipping`)
                    continue
                }

                const inventoryItemId = invItems[0].id

                // c) Create the reservation with allow_backorder=true — does NOT change stock quantity.
                //    Medusa reads allow_backorder from the reservation input (line 116 of inventory-module.js)
                //    to decide whether to enforce the stock quantity check during ensureInventoryLevels().
                console.log(`[convert-force] Creating reservation for lineItem ${lineItemId}, invItem ${inventoryItemId}`)
                const createRes = await fetch(`${base}/admin/reservations`, {
                    method: "POST",
                    headers: authHeaders,
                    body: JSON.stringify({
                        line_item_id: lineItemId,
                        inventory_item_id: inventoryItemId,
                        location_id: primaryLocationId,
                        quantity: lineItem.quantity ?? 1,
                        allow_backorder: true,   // ← bypasses the stock check in ensureInventoryLevels
                    }),
                })
                if (!createRes.ok) {
                    const err = await createRes.json().catch(() => ({}))
                    console.warn(`[convert-force] Reservation creation failed for ${lineItemId}:`, err?.message)
                }
            }
        }

        // ── Step 4: Retry conversion ───────────────────────────────────────────
        cvRes = await callConvert()
        cvJson = await cvRes.json()

        if (!cvRes.ok) {
            return void res.status(cvRes.status).json({
                ...cvJson,
                message: cvJson?.message ?? "Conversion failed even after creating missing reservations",
                backorder_attempted: true,
            })
        }

        // Fix payment collection post-conversion
        const correctTotal = await computeTrueTotal()
        if (correctTotal !== null) {
            await fixPaymentCollection(correctTotal)
        }

        // The order.placed event handles QB sync via subscriber — no explicit call needed.
        res.status(200).json({ ...cvJson, backorder_items_enabled: true })
    } catch (e: any) {
        console.error("[convert-force]", e?.message)
        res.status(500).json({ message: e?.message ?? "Conversion failed" })
    }
}

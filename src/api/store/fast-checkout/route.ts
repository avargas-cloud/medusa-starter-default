import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import {
    updateCartWorkflow,
    addShippingMethodToCartWorkflow,
    createPaymentCollectionForCartWorkflow,
    createPaymentSessionsWorkflow,
    completeCartWorkflow,
} from "@medusajs/medusa/core-flows"

// ─── Florida province mapping (must match exact Tax Region province_code in DB) 
const FL_VARIATIONS = ['fl', 'florida', 'fla', 'f.l.', 'florid']

function mapProvince(state?: string): string {
    if (!state) return ''
    const lower = state.trim().toLowerCase()
    if (FL_VARIATIONS.includes(lower)) return 'us-fl'
    return state.trim().toUpperCase()
}

// ─── Resolve optimistic/frontend shipping ID → real Medusa option ID
// Tries multiple strategies in order:
//   1. HTTP store API with publishable key + cart_id (fastest)
//   2. Medusa query.graph (native fallback)
//   3. FulfillmentModuleService list (direct DB fallback)
async function resolveShippingOptions(scope: any, cartId?: string): Promise<any[]> {
    // Strategy 1: HTTP store API — fastest
    try {
        const MEDUSA_URL = process.env.MEDUSA_BACKEND_URL || "http://localhost:9000"
        const PUBLISHABLE_KEY = process.env.PUBLISHABLE_API_KEY || ""
        const url = cartId
            ? `${MEDUSA_URL}/store/shipping-options?cart_id=${cartId}`
            : `${MEDUSA_URL}/store/shipping-options`
        const res = await fetch(url, {
            headers: {
                "Content-Type": "application/json",
                "x-publishable-api-key": PUBLISHABLE_KEY,
            }
        })
        if (res.ok) {
            const data = await res.json()
            const opts = data.shipping_options ?? []
            if (opts.length > 0) return opts
        }
    } catch (_) { }

    // Strategy 2: Medusa v2 query.graph
    try {
        const query = scope.resolve("query")
        const { data } = await query.graph({
            entity: "shipping_option",
            fields: ["id", "name", "amount", "provider_id"],
        })
        if (Array.isArray(data) && data.length > 0) return data
    } catch (_) { }

    // Strategy 3: FulfillmentModuleService (direct DB)
    try {
        const fulfillmentModule = scope.resolve("fulfillmentModuleService")
        const opts = await fulfillmentModule.listShippingOptions({})
        if (Array.isArray(opts) && opts.length > 0) return opts
    } catch (_) { }

    return []
}

async function resolveShippingOptionId(
    shippingMethodId: string,
    scope: any,
    cartId?: string
): Promise<string | null> {
    try {
        const options = await resolveShippingOptions(scope, cartId)

        if (!options || options.length === 0) {
            console.warn("[fast-checkout] resolveShippingOptionId: No shipping options found")
            return null
        }

        // 1. Exact ID match first (frontend already has the real so_... ID)
        const exact = options.find((o: any) => o.id === shippingMethodId)
        if (exact) {
            console.log(`[fast-checkout] Shipping: EXACT match ${exact.id} (${exact.name})`)
            return exact.id
        }

        // 2. Optimistic / alias matching
        const id = shippingMethodId.toLowerCase()
        const isPickup = id.includes("pickup") || id.includes("local")
        const isGround = id.includes("ground") || id.includes("optimistic_ground")

        if (isPickup) {
            const opt = options.find((o: any) =>
                o.name?.toLowerCase().includes("pickup") || o.provider_id?.includes("pickup")
            ) ?? options.find((o: any) => o.amount === 0)
            console.log(`[fast-checkout] Shipping: pickup → ${opt?.id}`)
            return opt?.id ?? null
        }

        if (isGround) {
            const groundOptions = options.filter((o: any) =>
                o.name?.toLowerCase().includes("ground") || o.provider_id?.includes("ground")
            )
            // Prefer the base "Ground Shipping" provider (custom flat-rate) over UPS Ground
            // since calculatePrice gives the correct dynamic price. Fall back to cheapest.
            const baseGround = groundOptions.find((o: any) =>
                o.provider_id?.includes("ground-shipping") || o.name?.toLowerCase() === "ground shipping"
            )
            const chosen = baseGround ?? groundOptions.sort((a: any, b: any) => (a.amount ?? 0) - (b.amount ?? 0))[0]
            console.log(`[fast-checkout] Shipping: ground → ${chosen?.id} (${chosen?.name})`)
            return chosen?.id ?? null
        }

        // 3. Last resort: most expensive (safest to avoid shipping profile mismatches)
        const sorted = [...options].sort((a: any, b: any) => (b.amount ?? 0) - (a.amount ?? 0))
        console.log(`[fast-checkout] Shipping: fallback → ${sorted[0]?.id} (${sorted[0]?.name})`)
        return sorted[0]?.id ?? null

    } catch (err: any) {
        console.error("[fast-checkout] resolveShippingOptionId error:", err.message)
        return null
    }
}

// ─── Main POST handler ────────────────────────────────────────────────────────
export async function POST(req: MedusaRequest, res: MedusaResponse) {
    const body = req.body as Record<string, any>

    const {
        cartId,
        email,
        shippingAddress,
        billingAddress,
        shippingMethodId,
        opaqueData,
        amount: frontendAmountDollars,
    } = body

    if (!cartId) {
        return res.status(400).json({ error: "Missing cartId" })
    }
    if (!opaqueData?.dataValue) {
        return res.status(400).json({ error: "Missing payment token (opaqueData)" })
    }

    try {
        // ── STEP 1: Map shipping address ──────────────────────────────────────
        const medusaShippingAddress = shippingAddress ? {
            first_name: shippingAddress.firstName,
            last_name: shippingAddress.lastName,
            company: shippingAddress.company || "",
            address_1: shippingAddress.address1,
            city: shippingAddress.city,
            province: mapProvince(shippingAddress.state),
            postal_code: shippingAddress.postcode,
            country_code: (shippingAddress.country || "us").toLowerCase(),
        } : undefined

        // ── STEP 2: Update cart (email + address in 1 call) ───────────────────
        if (email || medusaShippingAddress) {
            await updateCartWorkflow(req.scope).run({
                input: {
                    id: cartId,
                    ...(email ? { email } : {}),
                    ...(medusaShippingAddress ? { shipping_address: medusaShippingAddress } : {}),
                }
            })
            console.log(`[fast-checkout] ✅ Cart updated (email=${email})`)
        }

        // ── STEP 2b: Ensure customer_id linked ────────────────────────────────
        // If the customer is authenticated (JWT or session), make sure the cart
        // has customer_id set so completeCartWorkflow creates an order that appears
        // in their order history. guests (no auth_context) skip this step.
        const authenticatedCustomerId = (req as any).auth_context?.actor_id
        if (authenticatedCustomerId) {
            try {
                await updateCartWorkflow(req.scope).run({
                    input: { id: cartId, customer_id: authenticatedCustomerId }
                })
                console.log(`[fast-checkout] ✅ Customer linked: ${authenticatedCustomerId}`)
            } catch (linkErr: any) {
                // Non-fatal: log but continue — cart may already have the correct customer_id
                console.warn(`[fast-checkout] ⚠️ Could not link customer to cart: ${linkErr.message}`)
            }
        } else {
            console.log(`[fast-checkout] 👤 Guest checkout — no customer_id to link`)
        }

        // ── STEP 3: Resolve and apply shipping method ──────────────────────────
        if (shippingMethodId) {
            const resolvedOptionId = await resolveShippingOptionId(shippingMethodId, req.scope, cartId)
            if (resolvedOptionId) {
                await addShippingMethodToCartWorkflow(req.scope).run({
                    input: {
                        cart_id: cartId,
                        options: [{ id: resolvedOptionId }]
                    }
                })
                console.log(`[fast-checkout] ✅ Shipping method applied: ${resolvedOptionId}`)
            } else {
                console.warn(`[fast-checkout] ⚠️ Could not resolve shippingMethodId: ${shippingMethodId}`)
                // If no shipping method can be resolved, completeCart will fail.
                // Return early with a clear user-facing message.
                return res.status(400).json({
                    error: "Could not determine a valid shipping method. Please go back and re-select a shipping option."
                })
            }
        }

        // ── STEP 4: Get authoritative cart total via Store API ───────────────
        // We use the Store API (not cartModule.listCarts) because:
        //   1. The module service returns a stale floating-point total before the
        //      full price engine recalculates post-shipping.
        //   2. The Store API goes through Medusa's full price engine and returns
        //      a correct integer total in cents AFTER the shipping just applied.
        // NOTE: No reprice is done here intentionally — the customer saw these
        // prices in their cart and that is what must be charged. Any repricing
        // must happen before the customer reaches the payment step.
        let amountCents: number | null = null
        let cartItemsForValidation: any[] = []
        try {
            const MEDUSA_URL = process.env.MEDUSA_BACKEND_URL || "http://localhost:9000"
            const PUBLISHABLE_KEY = process.env.PUBLISHABLE_API_KEY || ""
            const cartRes = await fetch(`${MEDUSA_URL}/store/carts/${cartId}?fields=*items,items.unit_price,items.raw_unit_price,items.quantity,items.raw_quantity,items.variant_id,total,subtotal,item_subtotal`, {
                headers: {
                    "Content-Type": "application/json",
                    "x-publishable-api-key": PUBLISHABLE_KEY,
                }
            })
            if (cartRes.ok) {
                const { cart: cartData } = await cartRes.json()
                cartItemsForValidation = cartData?.items ?? []

                // Log full cart state for diagnostics
                console.log(`[fast-checkout] 🛒 Cart state: items=${cartItemsForValidation.length}, total=${cartData?.total}, subtotal=${cartData?.subtotal}, item_subtotal=${cartData?.item_subtotal}`)
                cartItemsForValidation.forEach((item: any) => {
                    console.log(`[fast-checkout]   - "${item.title}" qty=${item.quantity} unit_price=${item.unit_price} line_total=${(item.unit_price ?? 0) * (item.quantity ?? 0)}`)
                })

                // Store API returns totals in DOLLARS (e.g. 150.0568 for $150.06)
                // Multiply × 100 → round to integer cents for Authorize.net
                if (cartData?.total && cartData.total > 0) {
                    amountCents = Math.round(cartData.total * 100)
                    console.log(`[fast-checkout] 💰 Authoritative total (Store API): ${amountCents} cents = $${(amountCents / 100).toFixed(2)}`)
                }
            } else {
                console.warn(`[fast-checkout] Store API cart fetch returned ${cartRes.status}`)
            }
        } catch (err: any) {
            console.warn("[fast-checkout] Store API cart total fetch failed:", err.message)
        }

        // ── GUARD: Validate item prices are non-zero ──────────────────────────
        // Block checkout if any item has unit_price=0 — this means a pricing
        // configuration error (not a reprice scenario). The customer would be
        // charged only shipping, which is wrong.
        if (cartItemsForValidation.length > 0) {
            const zeroPriceItems = cartItemsForValidation.filter(
                (item: any) => !item.unit_price || item.unit_price <= 0
            )
            if (zeroPriceItems.length > 0) {
                const names = zeroPriceItems.map((i: any) => i.title || i.variant_id).join(", ")
                console.error(`[fast-checkout] ❌ Items with unit_price=0: ${names}`)
                return res.status(400).json({
                    error: "Some items in your cart could not be priced. Please remove them and add them again, or contact support.",
                    code: "ZERO_PRICE_ITEMS"
                })
            }
        }

        // Fallback: frontend dollar amount → cents
        if (!amountCents && frontendAmountDollars) {
            amountCents = Math.round(Number(frontendAmountDollars) * 100)
            console.warn(`[fast-checkout] ⚠️ Using frontend fallback amount: ${amountCents} cents = $${(amountCents / 100).toFixed(2)}`)
        }

        if (!amountCents || amountCents <= 0) {
            return res.status(400).json({
                error: "Could not determine cart total. Please refresh and try again."
            })
        }

        // ── STEP 4b: Fix raw_unit_price / raw_quantity on cart line items ─────────
        // completeCartWorkflow reads raw_unit_price (BigNumber JSONB), NOT unit_price,
        // to compute order_summary. Customer-group pricing sometimes sets unit_price
        // correctly but leaves raw_unit_price null or {value:"0"}, causing order_summary
        // to compute shipping+tax only. Fixing these BEFORE the workflow runs ensures
        // the RAM cache gets the correct total from the very first write.
        if (cartItemsForValidation.length > 0) {
            try {
                const cartModule = req.scope.resolve("cart") as any
                const rawFixes: any[] = []
                for (const item of cartItemsForValidation) {
                    const rawUpValue = parseFloat((item.raw_unit_price as any)?.value ?? "0")
                    const rawQtyValue = parseFloat((item.raw_quantity as any)?.value ?? "0")
                    const needsPriceFix = (item.unit_price ?? 0) > 0 && rawUpValue <= 0
                    const needsQtyFix = (item.quantity ?? 0) > 0 && rawQtyValue <= 0
                    if (needsPriceFix || needsQtyFix) {
                        const patch: Record<string, unknown> = { id: item.id }
                        if (needsPriceFix) patch.raw_unit_price = { value: String(item.unit_price), precision: 20 }
                        if (needsQtyFix) patch.raw_quantity = { value: String(item.quantity), precision: 20 }
                        rawFixes.push(patch)
                        console.log(`[fast-checkout] 🔧 Cart raw fix needed: "${item.title || item.variant_id}" price=${item.unit_price} qty=${item.quantity}`)
                    }
                }
                if (rawFixes.length > 0) {
                    await cartModule.updateLineItems(rawFixes)
                    console.log(`[fast-checkout] ✅ Fixed ${rawFixes.length} cart item(s) raw BigNumber fields → completeCartWorkflow will compute correct totals`)
                } else {
                    console.log(`[fast-checkout] ✅ Cart items raw_unit_price already correct — no fix needed`)
                }
            } catch (rawFixErr: any) {
                // Non-fatal: log and continue. The updateOrderItem in step 7b will compensate.
                console.warn(`[fast-checkout] ⚠️ Cart raw BigNumber fix failed (non-fatal): ${rawFixErr.message}`)
            }
        }

        // ── STEP 5: Create payment collection (idempotent — handles retries) ─────
        let paymentCollection: any
        try {
            const { result } = await createPaymentCollectionForCartWorkflow(req.scope).run({
                input: { cart_id: cartId }
            })
            paymentCollection = result
            console.log(`[fast-checkout] ✅ Payment collection created: ${paymentCollection?.id}`)
        } catch (pcErr: any) {
            // Cart already has a payment collection from a previous attempt — fetch and reuse it
            if (pcErr?.message?.toLowerCase().includes("already has a payment collection")) {
                try {
                    // Use query.graph through the cart entity — the correct Medusa v2 way
                    const query = req.scope.resolve("query") as any
                    const { data: [cartWithPayment] } = await query.graph({
                        entity: "cart",
                        filters: { id: cartId },
                        fields: ["id", "payment_collection.id", "payment_collection.status"],
                    })
                    paymentCollection = cartWithPayment?.payment_collection
                    if (paymentCollection?.id) {
                        console.log(`[fast-checkout] ✅ Reusing existing payment collection: ${paymentCollection.id}`)
                    } else {
                        throw new Error("Could not locate existing payment collection")
                    }
                } catch (_) {
                    throw pcErr  // rethrow original if we can't recover
                }
            } else {
                throw pcErr
            }
        }

        if (!paymentCollection?.id) {
            return res.status(500).json({ error: "Could not obtain payment collection. Please try again." })
        }

        // ── STEP 6: Create Authorize.net payment session ───────────────────────
        // Plugin reads: session.data.opaqueData, session.data.billingAddress, session.data.amount
        await createPaymentSessionsWorkflow(req.scope).run({
            input: {
                payment_collection_id: paymentCollection.id,
                provider_id: "pp_authorize-net_authorize-net",
                data: {
                    opaqueData,       // { dataDescriptor, dataValue } — Accept.js token
                    billingAddress,   // { firstName, lastName, address1, city, state, zip, country }
                    amount: amountCents,
                }
            }
        })
        console.log(`[fast-checkout] ✅ Payment session created`)

        // ── STEP 7: Complete cart → authorize + capture + create order ─────────
        let orderResult: any
        try {
            const { result } = await completeCartWorkflow(req.scope).run({
                input: { id: cartId }
            })
            orderResult = result
        } catch (workflowErr: any) {
            const msg: string = workflowErr?.message ?? ""

            // ── Stock / inventory error → return user-friendly 400 ──────────────
            // Medusa throws: "Not enough stock available for item iitem_XXX at location sloc_YYY"
            const stockMatch = msg.match(/Not enough stock available for item (\S+)/i)
            if (stockMatch) {
                const itemId = stockMatch[1]
                let productName = "one or more products"
                let sku = ""
                try {
                    // Look up the inventory item to get the SKU / product title via cart items
                    const cartModule = req.scope.resolve("cart") as any
                    // itemId might be an inventory_item id (iitem_) or order_item id
                    // Try to match against the cart's line items by variant
                    const cartDetail = await cartModule.retrieveCart(cartId, {
                        relations: ["items", "items.variant", "items.variant.inventory_items"]
                    }).catch(() => null)
                    const matchedItem = cartDetail?.items?.find((i: any) =>
                        i.variant?.inventory_items?.some((ii: any) => ii.inventory_item_id === itemId || ii.id === itemId)
                    )
                    if (matchedItem) {
                        productName = matchedItem.title ?? matchedItem.variant?.title ?? productName
                        sku = matchedItem.variant?.sku ?? ""
                    }
                } catch (_) { /* non-critical */ }

                const skuPart = sku ? ` (SKU: ${sku})` : ""
                console.warn(`[fast-checkout] ⚠️ Stock error for "${productName}"${skuPart}: ${msg}`)
                return res.status(400).json({
                    error: `Not enough stock available for "${productName}"${skuPart}. Please reduce the quantity or contact support.`,
                    code: "INSUFFICIENT_STOCK",
                    item: productName,
                    sku,
                })
            }

            // Re-throw other workflow errors (will be caught by outer catch)
            throw workflowErr
        }

        const order = (orderResult as any)?.order ?? orderResult
        let orderId = order?.id ?? null
        let displayId = order?.display_id ?? null

        // display_id is not always included in the completeCart result — fetch it directly
        if (orderId && !displayId) {
            try {
                const orderModule = req.scope.resolve("order") as any
                const [fullOrder] = await orderModule.listOrders(
                    { id: [orderId] },
                    { select: ["id", "display_id"] }
                )
                displayId = fullOrder?.display_id ?? null
            } catch (_) {
                // non-critical — order was created, display_id is cosmetic
            }
        }

        // ── STEP 7b: Fix order_item unit_prices (Admin display fix) ──────────────
        // PROBLEM: Medusa v2's completeCartWorkflow creates order_item v1 with
        // unit_price=$0 (pricing engine runs without customer group context).
        // The Admin reads v1 and shows only shipping+tax ($16.04 instead of $43.32).
        // The Store API correctly reads order_line_item.unit_price ($12.75) and
        // computes the right total, but the Admin uses order_item.unit_price.
        //
        // FIX: call orderModule.updateOrderItem() with the correct prices from the
        // cart (captured before completeCart ran). Per Medusa v2 event sourcing,
        // this creates a NEW version of each order_item that the Admin then reads.
        if (orderId && cartItemsForValidation.length > 0) {
            try {
                // Build variant_id → price object map from the pre-checkout cart snapshot
                const variantPriceMap = new Map<string, any>(
                    cartItemsForValidation
                        .filter((i: any) => i.variant_id && (i.unit_price ?? 0) > 0)
                        .map((i: any) => [
                            i.variant_id as string,
                            {
                                // ── Price fields ──────────────────────────────────────────────
                                unit_price: i.unit_price,
                                raw_unit_price: i.raw_unit_price ?? { value: String(i.unit_price), precision: 20 },
                                compare_at_unit_price: i.compare_at_unit_price ?? i.unit_price,
                                raw_compare_at_unit_price: i.raw_compare_at_unit_price ?? i.raw_unit_price ?? { value: String(i.unit_price), precision: 20 },
                                // ── Quantity fields ───────────────────────────────────────────
                                // CRITICAL FIX: transformPropertiesToBigNumber() reads raw_quantity
                                // JSONB and overwrites item.quantity. order_item.raw_quantity defaults
                                // to {"value":"0"} → quantity=0 → decorateCartTotals gives subtotal=0
                                // → Admin shows only shipping+tax ($16.04). Must set both fields.
                                quantity: i.quantity,
                                raw_quantity: i.raw_quantity ?? { value: String(i.quantity), precision: 20 },
                            }
                        ])
                )

                if (variantPriceMap.size > 0) {
                    // Get order line items' IDs and variant_ids via query.graph
                    // order.items → OrderLineItemDTO[] (order_line_item table)
                    // item.id   = order_line_item.id = order_item.item_id (FK)
                    const query = req.scope.resolve("query") as any
                    const { data: [orderWithItems] } = await query.graph({
                        entity: "order",
                        filters: { id: orderId },
                        fields: ["id", "items.id", "items.variant_id"],
                    })

                    const orderModule = req.scope.resolve("order") as any
                    const orderItems: any[] = orderWithItems?.items ?? []
                    let fixedCount = 0

                    for (const item of orderItems) {
                        const correctPrice = variantPriceMap.get(item.variant_id)
                        if (correctPrice) {
                            // Selector matches order_item records for this order + line item
                            // UpdateOrderItemDTO will update unit_price AND raw_unit_price JSONB
                            // Medusa v2 event sourcing will create a new version of the record
                            await orderModule.updateOrderItem(
                                { order_id: orderId, item_id: item.id },
                                correctPrice
                            )
                            fixedCount++
                            console.log(`[fast-checkout] ✅ Corrected order_item: ${item.variant_id} → $${correctPrice.unit_price} × ${correctPrice.quantity}`)
                        }
                    }

                    // ── Persist correct prices to DB (order_item v1 + order_summary) ──────
                    // ACTUAL ROOT CAUSE: Medusa computes order total from order_item v1
                    // (created by createOrdersStep with unit_price=null). It recomputes
                    // order_summary asynchronously from orditem_ v1 → overwrites any
                    // order_summary SQL we write. Admin reads that recomputed value → $16.04.
                    //
                    // FIX: Directly UPDATE order_item v1 rows, copying unit_price + raw_unit_price
                    // from order_line_item (which DOES have the correct prices from STEP 4b).
                    // When Medusa's async recomputation reads orditem_ v1, it sees correct
                    // prices → computes correct total → writes correct order_summary.
                    if (fixedCount > 0 && amountCents && amountCents > 0) {
                        const correctTotal = amountCents / 100
                        try {
                            const { Client } = await import("pg")
                            const pgClient = new Client({ connectionString: process.env.DATABASE_URL })
                            await pgClient.connect()

                            // STEP A: Fix order_item v1 — copy correct prices from order_line_item
                            const fixResult = await pgClient.query(`
                                UPDATE order_item oi
                                SET
                                    unit_price = oli.unit_price,
                                    raw_unit_price = oli.raw_unit_price
                                FROM order_line_item oli
                                WHERE oi.item_id = oli.id
                                  AND oi.order_id = $1
                                  AND oi.version = 1
                                  AND oi.unit_price IS NULL
                                  AND oli.unit_price IS NOT NULL
                            `, [orderId])
                            console.log(`[fast-checkout] ✅ Fixed ${fixResult.rowCount} order_item v1 row(s) prices from ordli_`)

                            // STEP B: Also directly update order_summary as an extra safety net.
                            // Even if Medusa re-reads orditem_ correctly, this ensures no window
                            // where the wrong total is visible.
                            await pgClient.query(`
                                UPDATE order_summary
                                SET totals = jsonb_set(
                                    jsonb_set(totals, '{current_order_total}', to_jsonb($1::float8)),
                                    '{accounting_total}', to_jsonb($1::float8)
                                )
                                WHERE order_id = $2
                            `, [correctTotal, orderId])
                            await pgClient.end()
                            console.log(`[fast-checkout] ✅ order_summary synced: $${correctTotal} for order ${orderId}`)
                        } catch (dbErr: any) {
                            console.warn(`[fast-checkout] ⚠️ DB fix failed (non-fatal): ${dbErr.message}`)
                        }
                        console.log(`[fast-checkout] ✅ Fixed ${fixedCount} order_item(s) — totals synced to DB`)
                    }
                }
            } catch (fixErr: any) {
                // Non-fatal: order is created + payment charged correctly.
                // Only the Admin display may still show the wrong total.
                console.warn(`[fast-checkout] ⚠️ order_item price fix skipped: ${fixErr.message}`)
            }
        }

        console.log(`[fast-checkout] 🎉 Order created: ${orderId} (#${displayId})`)
        return res.json({ ok: true, orderId, displayId })

    } catch (error: any) {
        const msg = error?.message ?? "Unknown error"
        console.error("[fast-checkout] ❌ Error:", msg)

        // Cart already completed (user retried after successful order, stale cart ID)
        if (msg.includes("already completed")) {
            return res.status(409).json({
                error: "This order has already been placed. Please refresh the page.",
                code: "CART_ALREADY_COMPLETED"
            })
        }
        if (msg.includes("shipping profile") || msg.includes("shipping method")) {
            return res.status(400).json({
                error: "The selected shipping method is not available for all items. Please go back and select a different shipping option."
            })
        }
        if (msg.includes("insufficient_inventory") || msg.includes("inventory")) {
            return res.status(400).json({
                error: "One or more items in your cart are out of stock. Please update your cart and try again."
            })
        }
        if (
            msg.includes("opaqueData") || msg.includes("card") ||
            msg.includes("authorize") || msg.includes("payment") ||
            msg.includes("E00027") || msg.includes("declined")
        ) {
            return res.status(402).json({
                error: "Payment authorization failed. Please check your card details and try again."
            })
        }

        return res.status(500).json({ error: "Checkout failed unexpectedly. Please try again." })
    }
}

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
            // Most expensive ground option → covers Long Item profiles too
            const groundOptions = options
                .filter((o: any) =>
                    o.name?.toLowerCase().includes("ground") || o.provider_id?.includes("ground")
                )
                .sort((a: any, b: any) => (b.amount ?? 0) - (a.amount ?? 0))
            console.log(`[fast-checkout] Shipping: ground → ${groundOptions[0]?.id}`)
            return groundOptions[0]?.id ?? null
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

        // ── STEP 4: Get authoritative cart total from Medusa DB ───────────────
        // Never trust the frontend amount — only Medusa knows the real total (post-tax, post-shipping).
        let amountCents: number | null = null
        try {
            const cartModule = req.scope.resolve("cart") as any
            const [cart] = await cartModule.listCarts({ id: [cartId] }, { select: ["total"] })
            if (cart?.total && cart.total > 0) {
                amountCents = cart.total
                console.log(`[fast-checkout] 💰 Authoritative total: ${amountCents} cents`)
            }
        } catch (err: any) {
            console.warn("[fast-checkout] cartModuleService not available:", err.message)
        }

        // Fallback: frontend dollar amount → cents
        if (!amountCents && frontendAmountDollars) {
            amountCents = Math.round(Number(frontendAmountDollars) * 100)
            console.warn(`[fast-checkout] ⚠️ Using frontend fallback amount: ${amountCents} cents`)
        }

        if (!amountCents || amountCents <= 0) {
            return res.status(400).json({
                error: "Could not determine cart total. Please refresh and try again."
            })
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
        const { result: orderResult } = await completeCartWorkflow(req.scope).run({
            input: { id: cartId }
        })

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

        console.log(`[fast-checkout] 🎉 Order created: ${orderId} (#${displayId})`)
        return res.json({ ok: true, orderId, displayId })

    } catch (error: any) {
        const msg = error?.message ?? "Unknown error"
        console.error("[fast-checkout] ❌ Error:", msg)

        // Specific error routing
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

/**
 * Fast Checkout Endpoint Test Script
 *
 * Tests the full checkout flow including:
 * - Cart creation + item addition
 * - VALIDATES that item prices are non-zero before checkout (reprice guard)
 * - Validates order total includes items (not just shipping)
 * - Generates a real Authorize.net token
 *
 * Run: NODE_OPTIONS="--dns-result-order=ipv4first" npx tsx src/scripts/test/test-fast-checkout.ts
 */

// ─── Authorize.net Credentials ────────────────────────────────────────────────
const AUTHNET_API_LOGIN = "8Ymj6M747q"
const AUTHNET_CLIENT_KEY = "5A5NMkXMUACqG6z9jkhp2AvTw6E72a7P6q9f53BWbvg779LNWtp8y4eJ4BdpqtwC"
const AUTHNET_ENVIRONMENT = "production"
const AUTHNET_ACCEPT_URL = AUTHNET_ENVIRONMENT === "production"
    ? "https://api.authorize.net/xml/v1/request.api"
    : "https://apitest.authorize.net/xml/v1/request.api"

// ─── Test card ────────────────────────────────────────────────────────────────
const TEST_CARD = {
    cardNumber: "4111111111111111",
    expirationDate: "2026-12",
    cardCode: "123",
}

function pass(msg: string) { console.log(`   ✅ ${msg}`) }
function fail(msg: string) { console.log(`   ❌ ${msg}`) }
function warn(msg: string) { console.log(`   ⚠️  ${msg}`) }
function section(n: number, title: string) { console.log(`\n── STEP ${n}: ${title} ──────────────────────────────`) }

// ─── Generate Authorize.net opaqueData token ──────────────────────────────────
async function getOpaqueData(): Promise<{ dataDescriptor: string; dataValue: string }> {
    const body = JSON.stringify({
        securePaymentContainerRequest: {
            merchantAuthentication: { name: AUTHNET_API_LOGIN, clientKey: AUTHNET_CLIENT_KEY },
            data: {
                type: "TOKEN",
                id: `test-${Date.now()}`,
                token: {
                    cardNumber: TEST_CARD.cardNumber,
                    expirationDate: TEST_CARD.expirationDate,
                    cardCode: TEST_CARD.cardCode,
                },
            },
        },
    })

    const res = await fetch(AUTHNET_ACCEPT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
    })
    if (!res.ok) throw new Error(`AuthNet token request failed: HTTP ${res.status}`)
    const data = await res.json()
    if (data?.messages?.resultCode !== "Ok") {
        throw new Error(`AuthNet token error: ${data?.messages?.message?.[0]?.text}`)
    }
    const opaqueData = data?.opaqueData
    if (!opaqueData?.dataValue) throw new Error("No opaqueData returned")
    return opaqueData
}

// ─── Main test ────────────────────────────────────────────────────────────────
async function testFastCheckout() {
    const MEDUSA_URL = "http://localhost:9000"
    const REGION_ID = "reg_01KFS28SNF1MT1MRHRAFQ6ZGK1"
    const PUBLISHABLE = "pk_519e7f66680afc4ab0136ce701a7f6d1e8df2b8fc48a29b7a55616a05cb5b5f3"
    const HEADERS = {
        "Content-Type": "application/json",
        "x-publishable-api-key": PUBLISHABLE,
    }

    let failed = false

    try {
        // ── STEP 1: Create cart ───────────────────────────────────────────────
        section(1, "Create cart")
        const cartRes = await fetch(`${MEDUSA_URL}/store/carts`, {
            method: "POST", headers: HEADERS,
            body: JSON.stringify({ region_id: REGION_ID }),
        })
        const { cart } = await cartRes.json()
        if (!cart?.id) throw new Error("Failed to create cart")
        pass(`Cart created: ${cart.id}`)

        // ── STEP 2: Add item ──────────────────────────────────────────────────
        section(2, "Add item to cart")
        const { products } = await fetch(
            `${MEDUSA_URL}/store/products?limit=20&fields=*variants`,
            { headers: HEADERS }
        ).then(r => r.json())

        let variantId: string | null = null
        let productTitle = ""
        for (const product of products ?? []) {
            if (variantId) break
            for (const variant of product.variants ?? []) {
                const addRes = await fetch(`${MEDUSA_URL}/store/carts/${cart.id}/line-items`, {
                    method: "POST", headers: HEADERS,
                    body: JSON.stringify({ variant_id: variant.id, quantity: 2 }),
                })
                if (addRes.ok) {
                    variantId = variant.id
                    productTitle = product.title
                    pass(`Added: "${product.title}" × 2 (variant: ${variant.id})`)
                    break
                }
            }
        }
        if (!variantId) throw new Error("No in-stock variant found")

        // ── STEP 3: Inspect cart item prices PRE-reprice ──────────────────────
        section(3, "Inspect item prices POST-add (before reprice)")
        const cartCheck1 = await fetch(
            `${MEDUSA_URL}/store/carts/${cart.id}?fields=*items,items.unit_price,items.quantity,total,subtotal,item_subtotal`,
            { headers: HEADERS }
        ).then(r => r.json())
        const items1 = cartCheck1?.cart?.items ?? []
        if (items1.length === 0) {
            fail("No items found in cart after add — check /store/carts fields expansion")
            failed = true
        } else {
            for (const item of items1) {
                const price = item.unit_price ?? 0
                const qty = item.quantity ?? 0
                if (price === 0) {
                    fail(`unit_price=0 for "${item.title}" — pricing engine did not apply a price`)
                    failed = true
                } else {
                    pass(`"${item.title}" × ${qty} @ $${price} (line total: $${price * qty})`)
                }
            }
        }
        const subtotal1 = cartCheck1?.cart?.subtotal ?? 0
        const total1 = cartCheck1?.cart?.total ?? 0
        console.log(`   cart.subtotal = $${subtotal1}`)
        console.log(`   cart.total    = $${total1}  (before shipping)`)

        // ── STEP 4: Get shipping option ───────────────────────────────────────
        section(4, "Get shipping option")
        const { shipping_options } = await fetch(
            `${MEDUSA_URL}/store/shipping-options?cart_id=${cart.id}`,
            { headers: HEADERS }
        ).then(r => r.json())
        if (!shipping_options?.length) throw new Error("No shipping options available")
        const shippingOption = shipping_options[0]
        pass(`Shipping: "${shippingOption.name}" (${shippingOption.id})`)

        // ── STEP 5: Get AuthNet token ─────────────────────────────────────────
        section(5, "Generate Authorize.net payment token")
        console.log(`   Card: **** **** **** ${TEST_CARD.cardNumber.slice(-4)} | Exp: ${TEST_CARD.expirationDate}`)
        const opaqueData = await getOpaqueData()
        pass(`Token received: ${opaqueData.dataDescriptor} | ${opaqueData.dataValue.slice(0, 30)}...`)

        // ── STEP 6: Fire fast-checkout ────────────────────────────────────────
        section(6, "Call POST /store/fast-checkout")
        const payload = {
            cartId: cart.id,
            email: "test.fast.checkout@ecopowertech.com",
            shippingAddress: {
                firstName: "Fast", lastName: "Tester",
                address1: "123 Speed Ave", city: "Miami",
                state: "FL", postcode: "33132", country: "us",
            },
            billingAddress: {
                firstName: "Fast", lastName: "Tester",
                address1: "123 Speed Ave", city: "Miami",
                state: "FL", zip: "33132", country: "US",
            },
            shippingMethodId: shippingOption.id,
            opaqueData,
        }

        const start = performance.now()
        const response = await fetch(`${MEDUSA_URL}/store/fast-checkout`, {
            method: "POST", headers: HEADERS,
            body: JSON.stringify(payload),
        })
        const elapsed = (performance.now() - start).toFixed(0)
        const data = await response.json().catch(() => ({}))

        console.log(`\n   HTTP ${response.status} in ${elapsed}ms`)
        console.log(`   Response: ${JSON.stringify(data, null, 2)}`)

        // ── STEP 7: Validate order ────────────────────────────────────────────
        section(7, "Validate order total in Medusa API")
        if (!response.ok) {
            fail(`Checkout failed: ${data?.error ?? "unknown"}`)
            failed = true
        } else {
            pass(`Order created: #${data.displayId} (${data.orderId})`)

            // Fetch the order to check totals
            if (data.orderId) {
                const orderRes = await fetch(
                    `${MEDUSA_URL}/store/orders/${data.orderId}?fields=total,subtotal,shipping_subtotal,tax_total,*items,items.unit_price,items.quantity,items.title`,
                    { headers: HEADERS }
                ).then(r => r.json()).catch(() => null)

                const order = orderRes?.order
                if (order) {
                    console.log(`\n   Order totals from Store API:`)
                    console.log(`     order.total             = $${order.total}`)
                    console.log(`     order.subtotal          = $${order.subtotal}`)
                    console.log(`     order.shipping_subtotal = $${order.shipping_subtotal}`)
                    console.log(`     order.tax_total         = $${order.tax_total}`)

                    // Check items
                    const orderItems = order.items ?? []
                    if (orderItems.length === 0) {
                        warn("No items returned — check fields expansion on /store/orders/:id")
                    } else {
                        for (const item of orderItems) {
                            const price = item.unit_price ?? 0
                            const qty = item.quantity ?? 0
                            if (price === 0 || qty === 0) {
                                fail(`PRICING BUG: "${item.title}" × ${qty} @ $${price}`)
                                failed = true
                            } else {
                                pass(`"${item.title}" × ${qty} @ $${price} = $${price * qty}`)
                            }
                        }
                    }

                    // Key check: subtotal should be > shipping_subtotal
                    const itemSubtotal = orderItems.reduce((sum: number, i: any) =>
                        sum + ((i.unit_price ?? 0) * (i.quantity ?? 0)), 0)
                    const shipping = order.shipping_subtotal ?? order.shipping_total ?? 0
                    if (itemSubtotal > 0 && itemSubtotal > shipping) {
                        pass(`Item subtotal $${itemSubtotal} > shipping $${shipping} — PRICING OK ✅`)
                    } else if (itemSubtotal === 0) {
                        fail(`Item subtotal = $0 — items were not priced correctly!`)
                        failed = true
                    } else {
                        warn(`Item subtotal $${itemSubtotal} ≤ shipping $${shipping} — may be a small order or pricing issue`)
                    }
                } else {
                    warn("Could not fetch order from Store API for validation")
                }
            }
        }

    } catch (e: any) {
        console.error("\n❌ Script error:", e.message)
        failed = true
    }

    // ── Summary ───────────────────────────────────────────────────────────────
    console.log("\n════════════════════════════════════════")
    if (failed) {
        console.log("❌ TEST FAILED — See above for details")
    } else {
        console.log("✅ ALL CHECKS PASSED")
    }
    console.log("════════════════════════════════════════\n")
}

testFastCheckout()

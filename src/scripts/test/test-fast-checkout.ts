/**
 * Fast Checkout Endpoint Test Script
 *
 * Generates a REAL Authorize.net opaqueData token using the test card:
 *   Visa: 4111 1111 1111 1111 | Exp: 12/2026 | CVV: 123
 *
 * Run: NODE_OPTIONS="--dns-result-order=ipv4first" npx tsx src/scripts/test/test-fast-checkout.ts
 */

// ─── Authorize.net Credentials ────────────────────────────────────────────────
const AUTHNET_API_LOGIN = "8Ymj6M747q"
const AUTHNET_CLIENT_KEY = "5A5NMkXMUACqG6z9jkhp2AvTw6E72a7P6q9f53BWbvg779LNWtp8y4eJ4BdpqtwC"
// Environment: production uses accept.authorize.net, sandbox uses apitest.authorize.net
const AUTHNET_ENVIRONMENT = "production"
const AUTHNET_ACCEPT_URL = AUTHNET_ENVIRONMENT === "production"
    ? "https://api.authorize.net/xml/v1/request.api"
    : "https://apitest.authorize.net/xml/v1/request.api"

// ─── Test card (Authorize.net standard Visa test card) ──────────────────────
const TEST_CARD = {
    cardNumber: "4111111111111111",
    expirationDate: "2026-12",
    cardCode: "123",
}

// ─── Generate opaqueData token from Authorize.net Accept.js API ──────────────
async function getOpaqueData(): Promise<{ dataDescriptor: string; dataValue: string }> {
    const body = JSON.stringify({
        securePaymentContainerRequest: {
            merchantAuthentication: {
                name: AUTHNET_API_LOGIN,
                clientKey: AUTHNET_CLIENT_KEY,
            },
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

    if (!res.ok) {
        throw new Error(`Authorize.net token request failed: HTTP ${res.status}`)
    }

    const data = await res.json()

    if (data?.messages?.resultCode !== "Ok") {
        const msg = data?.messages?.message?.[0]?.text ?? JSON.stringify(data)
        throw new Error(`Authorize.net token error: ${msg}`)
    }

    const opaqueData = data?.opaqueData
    if (!opaqueData?.dataValue) {
        throw new Error("No opaqueData returned from Authorize.net")
    }

    return opaqueData
}

// ─── Main test function ───────────────────────────────────────────────────────
async function testFastCheckout() {
    const MEDUSA_URL = "http://localhost:9000"
    const REGION_ID = "reg_01KFS28SNF1MT1MRHRAFQ6ZGK1"
    const HEADERS = {
        "Content-Type": "application/json",
        "x-publishable-api-key": "pk_519e7f66680afc4ab0136ce701a7f6d1e8df2b8fc48a29b7a55616a05cb5b5f3",
    }

    try {
        // ── STEP 1: Create cart ───────────────────────────────────────────────
        console.log("1. Creating test cart...")
        const cartRes = await fetch(`${MEDUSA_URL}/store/carts`, {
            method: "POST",
            headers: HEADERS,
            body: JSON.stringify({ region_id: REGION_ID }),
        })
        const { cart } = await cartRes.json()
        if (!cart) throw new Error("Failed to create cart")
        console.log(`   Cart ID: ${cart.id}\n`)

        // ── STEP 2: Add in-stock product ──────────────────────────────────────
        console.log("2. Finding an in-stock variant...")
        const { products } = await fetch(
            `${MEDUSA_URL}/store/products?limit=20&fields=*variants`,
            { headers: HEADERS }
        ).then(r => r.json())

        let variantId: string | null = null
        let productTitle = ""
        for (const product of products) {
            if (variantId) break
            for (const variant of product.variants ?? []) {
                const addRes = await fetch(`${MEDUSA_URL}/store/carts/${cart.id}/line-items`, {
                    method: "POST",
                    headers: HEADERS,
                    body: JSON.stringify({ variant_id: variant.id, quantity: 1 }),
                })
                if (addRes.ok) {
                    variantId = variant.id
                    productTitle = product.title
                    console.log(`   Added: ${product.title} (${variant.id})\n`)
                    break
                }
            }
        }
        if (!variantId) throw new Error("No in-stock variant found")

        // ── STEP 3: Get shipping option ───────────────────────────────────────
        console.log("3. Fetching shipping options...")
        const { shipping_options } = await fetch(
            `${MEDUSA_URL}/store/shipping-options?cart_id=${cart.id}`,
            { headers: HEADERS }
        ).then(r => r.json())
        if (!shipping_options?.length) throw new Error("No shipping options available")
        const shippingOption = shipping_options[0]
        console.log(`   Method: ${shippingOption.name} (${shippingOption.id})\n`)

        // ── STEP 4: Get real Authorize.net opaqueData token ───────────────────
        console.log("4. Generating Authorize.net payment token...")
        console.log(`   Card: **** **** **** ${TEST_CARD.cardNumber.slice(-4)} | Exp: ${TEST_CARD.expirationDate}`)
        const opaqueData = await getOpaqueData()
        console.log(`   Token: ${opaqueData.dataDescriptor} | ${opaqueData.dataValue.slice(0, 30)}...\n`)

        // ── STEP 5: Fire the Fast Checkout ────────────────────────────────────
        const payload = {
            cartId: cart.id,
            email: "test.fast.checkout@ecopowertech.com",
            shippingAddress: {
                firstName: "Fast",
                lastName: "Tester",
                address1: "123 Speed Ave",
                city: "Miami",
                state: "FL",
                postcode: "33132",
                country: "us",
            },
            billingAddress: {
                firstName: "Fast",
                lastName: "Tester",
                address1: "123 Speed Ave",
                city: "Miami",
                state: "FL",
                zip: "33132",
                country: "US",
            },
            shippingMethodId: shippingOption.id,
            opaqueData,
        }

        console.log("5. Calling POST /store/fast-checkout...")
        const start = performance.now()

        const response = await fetch(`${MEDUSA_URL}/store/fast-checkout`, {
            method: "POST",
            headers: HEADERS,
            body: JSON.stringify(payload),
        })

        const elapsed = (performance.now() - start).toFixed(0)
        const data = await response.json().catch(() => ({}))

        console.log("\n=========================================")
        console.log(`   Time:   ${elapsed}ms`)
        console.log(`   Status: ${response.status}`)
        console.log("=========================================\n")

        if (response.ok) {
            console.log("SUCCESS - Order created!")
            console.log(`   Order ID:   ${data.orderId}`)
            console.log(`   Display ID: #${data.displayId}`)
        } else {
            console.log(`FAILED: ${data?.error ?? "Unknown error"}`)
        }

    } catch (e: any) {
        console.error("Script error:", e.message)
    }
}

testFastCheckout()

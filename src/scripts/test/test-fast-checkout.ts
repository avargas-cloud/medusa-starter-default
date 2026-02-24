/**
 * Fast Checkout Endpoint Test Script — Full Order Validation
 *
 * Tests the complete checkout flow and validates what was STORED in the DB:
 * - Cart creation + item addition + price inspection
 * - Fast checkout (AuthNet token + POST /store/fast-checkout)
 * - Store API order validation (what the frontend sees)
 * - PostgreSQL direct query (what was PHYSICALLY STORED in the DB)
 *
 * Run: NODE_OPTIONS="--dns-result-order=ipv4first" npx tsx src/scripts/test/test-fast-checkout.ts
 */

import pg from 'pg'

// ─── Config ───────────────────────────────────────────────────────────────────
const AUTHNET_API_LOGIN = "8Ymj6M747q"
const AUTHNET_CLIENT_KEY = "5A5NMkXMUACqG6z9jkhp2AvTw6E72a7P6q9f53BWbvg779LNWtp8y4eJ4BdpqtwC"
const AUTHNET_ACCEPT_URL = "https://api.authorize.net/xml/v1/request.api"
const TEST_CARD = { cardNumber: "4111111111111111", expirationDate: "2026-12", cardCode: "123" }
const MEDUSA_URL = "http://localhost:9000"
const REGION_ID = "reg_01KFS28SNF1MT1MRHRAFQ6ZGK1"
const PUBLISHABLE = "pk_519e7f66680afc4ab0136ce701a7f6d1e8df2b8fc48a29b7a55616a05cb5b5f3"
const DATABASE_URL = process.env.DATABASE_URL || "postgresql://postgres:hUMSVtteMnqSBZSuSGUBivBooMdRoKtj@interchange.proxy.rlwy.net:34919/railway"
const HEADERS = { "Content-Type": "application/json", "x-publishable-api-key": PUBLISHABLE }

// ─── Helpers ──────────────────────────────────────────────────────────────────
function pass(msg: string) { console.log(`   ✅ ${msg}`) }
function fail(msg: string) { console.log(`   ❌ FAIL: ${msg}`) }
function warn(msg: string) { console.log(`   ⚠️  ${msg}`) }
function info(msg: string) { console.log(`   ℹ️  ${msg}`) }
function section(n: number, t: string) { console.log(`\n── STEP ${n}: ${t} ${'─'.repeat(Math.max(0, 50 - t.length))}`) }
function dollars(v: any): string { return v != null ? `$${Number(v).toFixed(2)}` : 'null' }

async function getOpaqueData() {
    const body = JSON.stringify({
        securePaymentContainerRequest: {
            merchantAuthentication: { name: AUTHNET_API_LOGIN, clientKey: AUTHNET_CLIENT_KEY },
            data: { type: "TOKEN", id: `test-${Date.now()}`, token: { ...TEST_CARD } },
        },
    })
    const res = await fetch(AUTHNET_ACCEPT_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body })
    if (!res.ok) throw new Error(`AuthNet HTTP ${res.status}`)
    const data = await res.json()
    if (data?.messages?.resultCode !== "Ok") throw new Error(`AuthNet: ${data?.messages?.message?.[0]?.text}`)
    return data.opaqueData
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function testFastCheckout() {
    let failed = false
    let orderId: string | null = null
    let displayId: number | null = null

    try {
        // ── STEP 1: Create cart ───────────────────────────────────────────────
        section(1, "Create cart")
        const { cart } = await fetch(`${MEDUSA_URL}/store/carts`, {
            method: "POST", headers: HEADERS, body: JSON.stringify({ region_id: REGION_ID })
        }).then(r => r.json())
        if (!cart?.id) throw new Error("Failed to create cart")
        pass(`Cart: ${cart.id}`)

        // ── STEP 2: Find + add item ───────────────────────────────────────────
        section(2, "Find in-stock variant & add to cart")
        const { products } = await fetch(`${MEDUSA_URL}/store/products?limit=20&fields=*variants`, { headers: HEADERS }).then(r => r.json())
        let variantId: string | null = null
        for (const product of products ?? []) {
            if (variantId) break
            for (const variant of (product.variants ?? [])) {
                const addRes = await fetch(`${MEDUSA_URL}/store/carts/${cart.id}/line-items`, {
                    method: "POST", headers: HEADERS,
                    body: JSON.stringify({ variant_id: variant.id, quantity: 2 })
                })
                if (addRes.ok) { variantId = variant.id; pass(`Added: "${product.title}" × 2 (${variant.id})`); break }
            }
        }
        if (!variantId) throw new Error("No in-stock variant found")

        // ── STEP 3: Inspect cart item prices ─────────────────────────────────
        section(3, "Inspect cart item prices")
        const { cart: cartCheck } = await fetch(
            `${MEDUSA_URL}/store/carts/${cart.id}?fields=*items,items.unit_price,items.quantity,items.title,total,subtotal,item_subtotal`,
            { headers: HEADERS }
        ).then(r => r.json())
        const items = cartCheck?.items ?? []
        if (!items.length) { fail("No items in cart"); failed = true }
        for (const item of items) {
            const price = item.unit_price ?? 0, qty = item.quantity ?? 0
            if (price === 0) { fail(`unit_price=0 for "${item.title}"`); failed = true }
            else pass(`"${item.title}" x${qty} @ ${dollars(price)} = ${dollars(price * qty)}`)
        }
        info(`cart.item_subtotal=${dollars(cartCheck?.item_subtotal)} | cart.subtotal=${dollars(cartCheck?.subtotal)} | cart.total=${dollars(cartCheck?.total)}`)

        // ── STEP 4: Get shipping option ───────────────────────────────────────
        section(4, "Get shipping option")
        const { shipping_options } = await fetch(`${MEDUSA_URL}/store/shipping-options?cart_id=${cart.id}`, { headers: HEADERS }).then(r => r.json())
        if (!shipping_options?.length) throw new Error("No shipping options")
        const shippingOption = shipping_options[0]
        pass(`"${shippingOption.name}" (${shippingOption.id})`)

        // ── STEP 5: AuthNet token ─────────────────────────────────────────────
        section(5, "Generate Authorize.net payment token")
        const opaqueData = await getOpaqueData()
        pass(`Token: ${opaqueData.dataDescriptor} | ${opaqueData.dataValue.slice(0, 30)}...`)

        // ── STEP 6: Fire fast-checkout ────────────────────────────────────────
        section(6, "POST /store/fast-checkout")
        const start = performance.now()
        const response = await fetch(`${MEDUSA_URL}/store/fast-checkout`, {
            method: "POST", headers: HEADERS,
            body: JSON.stringify({
                cartId: cart.id,
                email: "test.fast.checkout@ecopowertech.com",
                shippingAddress: { firstName: "Fast", lastName: "Tester", address1: "123 Speed Ave", city: "Miami", state: "FL", postcode: "33132", country: "us" },
                billingAddress: { firstName: "Fast", lastName: "Tester", address1: "123 Speed Ave", city: "Miami", state: "FL", zip: "33132", country: "US" },
                shippingMethodId: shippingOption.id,
                opaqueData,
            }),
        })
        const elapsed = (performance.now() - start).toFixed(0)
        const data = await response.json().catch(() => ({}))
        info(`HTTP ${response.status} in ${elapsed}ms`)
        if (!response.ok) { fail(`Checkout failed: ${data?.error}`); failed = true; return }
        pass(`Order created: #${data.displayId} (${data.orderId})`)
        orderId = data.orderId
        displayId = data.displayId

        // ── STEP 7: Store API — what the frontend sees ────────────────────────
        section(7, "Store API — order as seen by the frontend")
        const orderStoreRes = await fetch(
            `${MEDUSA_URL}/store/orders/${orderId}?fields=total,subtotal,item_subtotal,shipping_subtotal,shipping_total,tax_total,discount_total,*items,items.unit_price,items.quantity,items.title,items.variant_id,items.subtotal,items.total,currency_code`,
            { headers: HEADERS }
        ).then(r => r.json()).catch(() => null)
        const storeOrder = orderStoreRes?.order
        if (!storeOrder) {
            warn("Could not fetch order from Store API (may require customer auth)")
        } else {
            console.log(`\n   ┌─ Store API Totals ───────────────────────────────────`)
            console.log(`   │  order.total             = ${dollars(storeOrder.total)}`)
            console.log(`   │  order.subtotal          = ${dollars(storeOrder.subtotal)}`)
            console.log(`   │  order.item_subtotal     = ${dollars(storeOrder.item_subtotal)}`)
            console.log(`   │  order.shipping_subtotal = ${dollars(storeOrder.shipping_subtotal)}`)
            console.log(`   │  order.tax_total         = ${dollars(storeOrder.tax_total)}`)
            console.log(`   │  order.discount_total    = ${dollars(storeOrder.discount_total)}`)
            console.log(`   └──────────────────────────────────────────────────────`)
            const storeItems = storeOrder.items ?? []
            if (!storeItems.length) warn("No items in Store API response")
            for (const item of storeItems) {
                const price = item.unit_price ?? 0, qty = item.quantity ?? 0
                console.log(`   📦 "${item.title}"`)
                console.log(`      SKU/variant: ${item.variant_id}`)
                console.log(`      qty=${qty} | unit_price=${dollars(price)} | line=${dollars(price * qty)}`)
                if (price === 0 || qty === 0) { fail(`unit_price or qty is 0!`); failed = true }
            }
        }

        // ── STEP 8: PostgreSQL — raw stored values ────────────────────────────
        section(8, "PostgreSQL — raw stored values in DB")
        const client = new pg.Client({ connectionString: DATABASE_URL })
        await client.connect()
        try {
            // Introspect actual columns to avoid column-not-found errors
            const colsRes = await client.query<any>(`
                SELECT column_name
                FROM information_schema.columns
                WHERE table_name = 'order'
                ORDER BY ordinal_position
            `)
            const orderCols = colsRes.rows.map((r: any) => r.column_name as string)

            // Build safe SELECT list from columns that actually exist
            const wantedOrderCols = [
                'id', 'display_id', 'status', 'currency_code',
                'total', 'subtotal', 'item_subtotal',
                'shipping_total', 'shipping_subtotal',
                'tax_total', 'discount_total',
                'created_at'
            ].filter(c => orderCols.includes(c))

            const orderRow = await client.query<any>(
                `SELECT ${wantedOrderCols.map(c => `o."${c}"`).join(', ')} FROM "order" o WHERE o.id = $1`,
                [orderId]
            )

            if (!orderRow.rows.length) {
                fail(`Order ${orderId} not found in DB`)
                failed = true
            } else {
                const o = orderRow.rows[0]
                console.log(`\n   ┌─ DB: order table ────────────────────────────────────`)
                console.log(`   │  id             = ${o.id}`)
                console.log(`   │  display_id     = #${o.display_id}`)
                console.log(`   │  status         = ${o.status}`)
                console.log(`   │  currency       = ${o.currency_code}`)
                console.log(`   │  total          = ${dollars(o.total)}   ← admin list shows this`)
                console.log(`   │  subtotal       = ${dollars(o.subtotal)}`)
                console.log(`   │  item_subtotal  = ${dollars(o.item_subtotal)}`)
                console.log(`   │  shipping_total = ${dollars(o.shipping_total)}`)
                console.log(`   │  shipping_sub   = ${dollars(o.shipping_subtotal)}`)
                console.log(`   │  tax_total      = ${dollars(o.tax_total)}`)
                console.log(`   │  discount_total = ${dollars(o.discount_total)}`)
                console.log(`   └──────────────────────────────────────────────────────`)

                const storedTotal = Number(o.total ?? 0)
                const storedShipping = Number(o.shipping_subtotal ?? o.shipping_total ?? 0)
                if (storedTotal > 0 && storedTotal > storedShipping + 5) {
                    pass(`DB total ${dollars(storedTotal)} > shipping ${dollars(storedShipping)} — ITEMS PRICED IN DB ✅`)
                } else {
                    fail(`DB total ${dollars(storedTotal)} ≈ shipping only ${dollars(storedShipping)} — BUG: items not priced in stored total ❌`)
                    failed = true
                }
            }

            // Line items
            const liColsRes = await client.query<any>(`
                SELECT column_name FROM information_schema.columns
                WHERE table_name = 'order_line_item' ORDER BY ordinal_position
            `)
            const liCols = liColsRes.rows.map((r: any) => r.column_name as string)
            const wantedLiCols = ['id', 'title', 'quantity', 'unit_price', 'compare_at_unit_price',
                'subtotal', 'total', 'tax_total', 'variant_id'].filter(c => liCols.includes(c))

            const lineItems = await client.query<any>(
                `SELECT ${wantedLiCols.map(c => `li."${c}"`).join(', ')}, v.sku
                 FROM order_line_item li
                 LEFT JOIN product_variant v ON v.id = li.variant_id
                 WHERE li.order_id = $1
                 ORDER BY li.created_at`,
                [orderId]
            )

            console.log(`\n   ┌─ DB: order_line_item table ──────────────────────────`)
            if (!lineItems.rows.length) {
                warn("No line items found in order_line_item table")
            } else {
                for (const li of lineItems.rows) {
                    console.log(`   │  "${li.title}"`)
                    console.log(`   │    SKU:        ${li.sku ?? 'N/A'}`)
                    console.log(`   │    quantity:   ${li.quantity}`)
                    console.log(`   │    unit_price: ${dollars(li.unit_price)}`)
                    console.log(`   │    subtotal:   ${dollars(li.subtotal)}`)
                    console.log(`   │    total:      ${dollars(li.total)}`)
                    console.log(`   │    tax_total:  ${dollars(li.tax_total)}`)
                    if (!li.unit_price || Number(li.unit_price) === 0) {
                        fail(`unit_price=0 in DB for this item!`); failed = true
                    }
                }
            }
            console.log(`   └──────────────────────────────────────────────────────`)

            // ── STEP 9: order_item — raw_quantity fix validation ──────────────
            // This is the definitive check: transformPropertiesToBigNumber reads
            // raw_quantity JSONB; if it's {"value":"0"} the Admin sees qty=0 → $16 total.
            // Our fix passes quantity + raw_quantity to updateOrderItem after completeCart.
            section(9, "order_item — raw_quantity + raw_unit_price (Admin fix)")
            const orderItemRows = await client.query<any>(
                `SELECT oi.id, oi.version, oi.quantity, oi.raw_quantity,
                        oi.unit_price, oi.raw_unit_price, oli.title, oli.variant_id
                   FROM order_item oi
                   JOIN order_line_item oli ON oli.id = oi.item_id
                  WHERE oi.order_id = $1
                  ORDER BY oi.version DESC, oi.created_at`,
                [orderId]
            )
            if (!orderItemRows.rows.length) {
                warn("No rows in order_item table — check order creation")
            } else {
                console.log(`\n   ┌─ DB: order_item table (Admin reads latest version) ──`)
                for (const oi of orderItemRows.rows) {
                    const rawQtyVal = oi.raw_quantity?.value ?? '?'
                    const rawPriceVal = oi.raw_unit_price?.value ?? '?'
                    const qtyOk = Number(rawQtyVal) > 0
                    const priceOk = Number(rawPriceVal) > 0
                    console.log(`   │  "${oi.title}"`)
                    console.log(`   │    version:         ${oi.version}`)
                    console.log(`   │    quantity:        ${oi.quantity}  raw_quantity.value="${rawQtyVal}"  ${qtyOk ? '✅' : '❌ ZERO — Admin will show $0 subtotal!'}`)
                    console.log(`   │    unit_price:      ${dollars(oi.unit_price)}  raw_unit_price.value="${rawPriceVal}"  ${priceOk ? '✅' : '❌ ZERO'}`)
                    if (!qtyOk) { fail(`raw_quantity.value="0" — decorateCartTotals will compute qty=0!`); failed = true }
                    if (!priceOk) { fail(`raw_unit_price.value="0" — items not priced!`); failed = true }
                }
                console.log(`   └──────────────────────────────────────────────────────`)
            }
        } finally {
            await client.end()
        }

    } catch (e: any) {
        console.error("\n❌ Script error:", e.message)
        if (orderId) info(`Partial order created: ${orderId}`)
        failed = true
    }

    // ── Summary ───────────────────────────────────────────────────────────────
    console.log("\n" + "═".repeat(52))
    if (failed) console.log("❌  TEST FAILED — see ❌ markers above")
    else console.log("✅  ALL CHECKS PASSED")
    if (orderId) console.log(`   Order: #${displayId} | ${orderId}`)
    console.log("═".repeat(52) + "\n")
}

testFastCheckout()

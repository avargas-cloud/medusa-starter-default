# Checkout + Payment Implementation Guide

## 📋 Descripción del Documento

| Campo | Detalle |
|-------|---------|
| **Propósito** | Complete implementation guide for checkout and payment processing using Authorize.net (Accept.js) as the payment provider in Medusa v2, integrated with the Astro storefront — from cart creation through order confirmation. |
| **Problemas que resuelve** | Medusa v2 payment integration with Authorize.net is not well documented. This covers the custom payment provider plugin, the fast-checkout backend endpoint, and the Astro frontend steps. |
| **Resultado esperado** | End-to-end checkout works: cart → shipping → payment → order creation in ~2-3 seconds from the user's perspective. Authorize.net charges the card, Medusa creates the order, and the customer receives a confirmation. |
| **Scripts Creados** | `src/scripts/test/test-fast-checkout.ts` — end-to-end checkout test with real Authorize.net token generation |
| **Última actualización** | 2026-02-24 — Currency unit fixes: Medusa v2 uses DOLLARS throughout; Authorize.net service no longer divides by 100. Store API used for authoritative cart total. Frontend display fixed. |

---

## Architecture Overview (Current)

```
[Customer Browser]
     │
     │  1. Accept.js tokenizes card → opaqueData
     │
     ▼
[Astro Frontend / Vercel]
     │
     │  2. Single POST to Medusa with { cartId, opaqueData, billing, shipping, shippingMethodId }
     │     Header: x-publishable-api-key
     │
     ▼
[Medusa Backend / Railway]  POST /store/fast-checkout
     │
     ├── updateCartWorkflow          (email + shipping address)
     ├── resolveShippingOptionId     (exact → pickup → ground → cost-sorted fallback)
     ├── addShippingMethodToCartWorkflow
     ├── GET /store/carts/:id        (Store API — authoritative total in DOLLARS)
     ├── createPaymentCollectionForCartWorkflow
     ├── createPaymentSessionsWorkflow  (stores opaqueData + billingAddress + amount)
     └── completeCartWorkflow        → authorizePayment → capturePayment → Order created
                │
                ▼
          [Authorize.net]  chargeCard($amount, opaqueData)
                │              amount is already in DOLLARS — no unit conversion needed
                │
                ▼
          [Order Created in Medusa]
```

> **Why one endpoint?** Previously the frontend made 5-6 sequential API calls to Railway.
> Each call added ~30ms network latency and time-outs were common. The single endpoint
> reduces checkout time from 10-15s to ~2-3s in production.

---

## Part 1: Medusa Backend Setup

### 1.1 Authorize.net Payment Provider

Path: `backend/src/modules/authorize-net/`

The provider implements `AbstractPaymentProvider` from `@medusajs/framework/utils`.
Key methods and what they do:

| Method | When called | What it does |
|--------|------------|--------------|
| `initiatePayment` | Session created | Generates a local session ID, stores amount |
| `authorizePayment` | Cart completion | Delegates to `capturePayment` (auth+capture in one step) |
| `capturePayment` | Order creation | Calls Authorize.net `authCaptureTransaction` with opaqueData |
| `cancelPayment` | Order cancellation | Calls Authorize.net `voidTransaction` |
| `refundPayment` | Admin refund | Calls Authorize.net `refundTransaction` |

**Payment session data shape** (stored in `payment_session.data`):
```typescript
{
  opaqueData: {
    dataDescriptor: "COMMON.ACCEPT.INAPP.PAYMENT",
    dataValue: "eyJjb2RlIjoiNTBfMl8wNj..."  // Accept.js JWT token
  },
  billingAddress: {
    firstName, lastName, address1, city, state, zip, country
  },
  amount: 76.76  // DOLLARS — Medusa v2 stores and passes monetary amounts in dollars (not cents)
}
```

> **⚠️ CRITICAL — Currency Units:**
> Medusa v2 stores ALL monetary values (cart total, payment session amount, refund amount) in **DOLLARS**
> as floating-point numbers (e.g. `76.7618`). The `capturePayment` and `refundPayment` methods
> in `authorize-net/service.ts` use the amount **directly** without dividing by 100.
> Authorize.net also expects dollars, so no conversion is needed.
> **Never divide Medusa amounts by 100** — doing so results in charging cents instead of dollars.

### 1.2 Required Environment Variables

```bash
# Backend (Railway)
AUTHORIZENET_API_LOGIN_ID=your_login_id
AUTHORIZENET_TRANSACTION_KEY=your_transaction_key
AUTHORIZENET_ENVIRONMENT=production   # or 'sandbox'
PUBLISHABLE_API_KEY=pk_...            # used by fast-checkout HTTP fallback
MEDUSA_BACKEND_URL=https://your-backend.railway.app

# Frontend (Vercel)
PUBLIC_MEDUSA_BACKEND_URL=https://your-backend.railway.app
PUBLIC_MEDUSA_PUBLISHABLE_KEY=pk_...
PUBLIC_AUTHORIZENET_CLIENT_KEY=5A5NMk...  # Accept.js public key (from Auth.net dashboard)
```

### 1.3 Fast Checkout Endpoint

File: `backend/src/api/store/fast-checkout/route.ts`

**Endpoint:** `POST /store/fast-checkout`

**Request body:**
```typescript
{
  cartId: string                    // Medusa cart ID
  email?: string                    // Customer email
  shippingAddress?: {               // Shipping address (snakeCase handled server-side)
    firstName, lastName, address1, city, state, postcode, country
  }
  billingAddress?: {                // Passed to Authorize.net billTo
    firstName, lastName, address1, city, state, zip, country
  }
  shippingMethodId: string          // Can be real so_... ID or alias like "optimistic_ground"
  opaqueData: {                     // Accept.js payment token
    dataDescriptor: string
    dataValue: string
  }
  amount?: number                   // Dollars (fallback only — Medusa total takes priority)
}
```

**Response (success):**
```json
{ "ok": true, "orderId": "order_01...", "displayId": 1014 }
```

**Response (error):**
```json
{ "error": "User-friendly message" }
```

**User-facing error routing:**
- Shipping profile mismatch → 400 with message to re-select shipping
- Out of stock → 400 with stock message  
- Payment declined / opaqueData rejected → 402 with payment message
- Unexpected error → 500

### 1.4 Shipping Option Resolution

The endpoint resolves the frontend's `shippingMethodId` to a real Medusa `so_...` ID using
this priority ladder:

1. **Exact match** — if the ID is already a valid `so_...` ID, use it directly
2. **Alias: pickup** — matches any option with "pickup" in name/provider_id
3. **Alias: ground** — matches "ground" options, sorted by price descending (most expensive first — covers Long Item shipping profile)
4. **Last resort fallback** — most expensive available option

Shipping options are fetched using this priority:
1. HTTP to `/store/shipping-options` with `PUBLISHABLE_API_KEY` (fastest)
2. `query.graph` via Medusa DI container
3. `fulfillmentModuleService.listShippingOptions()`

### 1.5 Florida Province Mapping

Medusa's tax regions require an exact `province_code` match (e.g., `us-fl`).
The route normalizes the state before passing it to `updateCartWorkflow`:

```typescript
const FL_VARIATIONS = ['fl', 'florida', 'fla', 'f.l.', 'florid']
// "FL" or "Florida" → "us-fl" to match the tax region in the DB
```

---

## Part 2: Frontend Checkout Flow

The checkout has 3 steps in `frontend/src/features/checkout/`:

```
Step 1: Contact & Delivery  (StepInfo.tsx)
  └── Customer email, shipping address
  └── Stored in checkoutStore (nanostores)

Step 2: Shipping Method  (ShippingMethodSelector.tsx)
  └── Fetches /store/shipping-options?cart_id=...
  └── Stores selected shippingMethodId in checkoutStore

Step 3: Payment  (StepPayment.tsx + usePaymentForm.ts)
  └── Accept.js tokenizes card → opaqueData
  └── Single POST to /store/fast-checkout
  └── On success: redirect to /order-confirmation?orderId=...
```

### 2.1 Accept.js Token Generation

Accept.js is loaded via script tag and called client-side:

```typescript
// The card never touches our servers — it goes: browser → Authorize.net → opaqueData token
window.Accept.dispatchData({
  authData: {
    clientKey: import.meta.env.PUBLIC_AUTHORIZENET_CLIENT_KEY,  // Public key from Auth.net dashboard
    apiLoginID: import.meta.env.PUBLIC_AUTHORIZENET_LOGIN_ID,  // API login ID
  },
  cardData: {
    cardNumber: form.cardNumber.replace(/\s/g, ''),
    month:      form.month,    // "12"
    year:       form.year,     // "2026"
    cardCode:   form.cvv,
  }
}, (response) => {
  if (response.messages.resultCode === "Ok") {
    const opaqueData = response.opaqueData  // { dataDescriptor, dataValue }
    // → POST to /store/fast-checkout
  }
})
```

### 2.2 Calling Fast Checkout (usePaymentForm.ts)

```typescript
const MEDUSA_URL = import.meta.env.PUBLIC_MEDUSA_BACKEND_URL || "http://localhost:9000"
const PUBLISHABLE_KEY = import.meta.env.PUBLIC_MEDUSA_PUBLISHABLE_KEY || ""

const res = await fetch(`${MEDUSA_URL}/store/fast-checkout`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "x-publishable-api-key": PUBLISHABLE_KEY,  // REQUIRED — Medusa rejects without this
  },
  credentials: "omit",
  body: JSON.stringify({
    cartId: medusaCartId,
    opaqueData,
    billingAddress: billing,
    shippingAddress: store.shippingAddress,
    amount: amountDollars,       // Dollars (fallback only)
    shippingMethodId,
    email,
  }),
})
```

> **⚠️ CRITICAL:** The `x-publishable-api-key` header is **required** for all `/store/*` endpoints.
> Missing it causes a 400 "Publishable API key required" error before the route handler is even reached.

---

## Part 3: Cart Lifecycle

### 3.1 Create Cart

```typescript
// POST /store/carts  (requires x-publishable-api-key)
const { cart } = await fetch('/store/carts', {
  method: "POST",
  headers: { "x-publishable-api-key": PUBLISHABLE_KEY },
  body: JSON.stringify({ region_id: 'reg_xxx' })
}).then(r => r.json())
localStorage.setItem('ept_cart_v2:cartId', cart.id)
```

### 3.2 Associate Customer (Wholesale Pricing)

When a logged-in customer has a guest cart:

```typescript
// POST /store/carts/:id/customer
await fetch(`/store/carts/${cartId}/customer`, {
  method: "POST",
  headers: {
    "x-publishable-api-key": PUBLISHABLE_KEY,
    "Authorization": `Bearer ${token}`
  }
})
```

> ⚠️ **CRITICAL:** Must happen BEFORE adding items for wholesale pricing to apply.

### 3.3 Line Items

```typescript
// POST /store/carts/:id/line-items
await fetch(`/store/carts/${cartId}/line-items`, {
  method: "POST",
  headers: { "x-publishable-api-key": PUBLISHABLE_KEY },
  body: JSON.stringify({ variant_id: 'variant_xxx', quantity: 2 })
})
```

---

## Part 4: Wholesale Pricing in Cart (B2B)

### Problem

Medusa v2 does NOT automatically apply customer group price lists.

### Solution: `setPricingContext` Workflow Hooks

File: `backend/src/workflows/hooks/set-cart-pricing-context.ts`

Hooks registered on `addToCartWorkflow`, `updateLineItemInCartWorkflow`, and `addShippingMethodToCartWorkflow` inject the customer's group IDs as pricing context, enabling price list matching.

```typescript
addToCartWorkflow.hooks.setPricingContext(async ({ cart }, { container }) => {
    if (!cart?.customer_id) return new StepResponse({})
    const customerModule = container.resolve(Modules.CUSTOMER)
    const customer = await customerModule.retrieveCustomer(cart.customer_id, { relations: ["groups"] })
    if (!customer.groups?.length) return new StepResponse({})
    return new StepResponse({ customer_group_id: customer.groups.map(g => g.id) })
})
```

---

## Part 5: Common Gotchas

### ⚠️ Currency Units — The #1 Source of Subtle Bugs

Medusa v2 stores ALL monetary values in **DOLLARS** (not cents). This applies to:
- `cart.total`, `cart.item_subtotal`, `cart.shipping_subtotal`, `cart.tax_total`
- `payment_session.data.amount`
- The `data.amount` passed to `authorizePayment()` / `capturePayment()`
- Refund amounts passed to `refundPayment()`

The Authorize.net API also expects **dollars**. No unit conversion is needed.

**Wrong (caused $0.77 charge instead of $76.76):**
```typescript
// ❌ WRONG: divides dollars by 100, charges cents
const amountDollars = (sessionData.amount / 100).toFixed(2)  // 76.76 → $0.77
```

**Correct:**
```typescript
// ✅ CORRECT: amount is already in dollars
const amountDollars = Number(sessionData.amount).toFixed(2)  // 76.76 → $76.76
```

### Authoritative Cart Total — Use Store API, Not listCarts

`cartModule.listCarts()` can return stale totals before shipping is applied.
Always use the Store API for the authoritative total after shipping is set:

```typescript
// ✅ Authoritative total (use this)
const res = await fetch(`${MEDUSA_BACKEND_URL}/store/carts/${cartId}`, {
  headers: { 'x-publishable-api-key': PUBLISHABLE_API_KEY }
})
const { cart: cartData } = await res.json()
const amountCents = Math.round(cartData.total * 100)  // for logging only
console.log(`[fast-checkout] 💰 Total: $${cartData.total.toFixed(2)}`)
```

> The Store API returns `total`, `item_subtotal`, `shipping_subtotal`, `tax_total` all in **dollars**.

### Shipping Display: shipping_subtotal vs shipping_total

Medusa's order object has two shipping fields:

| Field | Value | What it contains |
|-------|-------|------------------|
| `shipping_subtotal` | $14.99 | Base shipping cost (no tax) |
| `shipping_total` | $16.04 | Base + shipping tax ($1.05) |

**Always display `shipping_subtotal`** in the UI. `tax_total` already includes the shipping tax.
Using `shipping_total` + `tax_total` double-counts the shipping tax (+$1.05 in FL).

```typescript
// ✅ Correct — tax_total includes shipping tax
const shipping = order.shipping_subtotal  // $14.99
const tax = order.tax_total              // $5.02 (covers items + shipping)
// Total = subtotal + shipping + tax = $56.75 + $14.99 + $5.02 = $76.76 ✅

// ❌ Wrong — double counts shipping tax
const shipping = order.shipping_total    // $16.04 (already includes $1.05 tax)
const tax = order.tax_total             // $5.02 (also includes that $1.05)
// Total = $56.75 + $16.04 + $5.02 = $77.81 ❌
```

### Florida Tax — 7% on Items + Shipping

Florida law (F.S. 212.02) taxes the shipping cost along with items. Medusa's tax engine
calculates this correctly if the province is set to `us-fl`. The frontend mirrors this:

```typescript
// Client-side calculation in CheckoutLayout.tsx:
const FL_TAX_RATE = 0.07
const taxableBase = subtotal + shippingCost  // includes shipping!
const tax = taxableBase * FL_TAX_RATE
```

### Cart Drawer Doesn't Open on First Item Add

The `ept:cart-updated` event that opens the cart drawer must fire for the empty-cart case.
The optimistic update branch (`else if (previousCart)`) only fires when a cart already exists.
For the first item ever added (no `previousCart`), dispatch the event after the API call:

```typescript
// cartStore.ts — after apiAddToCart succeeds:
if (!product.silent && !previousCart) {
  window.dispatchEvent(new CustomEvent('ept:cart-updated', { detail: { action: 'add' } }));
}
```

### Cart completion fails with "No shipping method selected"

- The `shippingMethodId` from the frontend couldn't be resolved to a real `so_...` ID
- Check the `[fast-checkout] Shipping:` logs on Railway to see which strategy was used
- Verify the shipping option ID in the frontend matches what Medusa returns

### "Publishable API key required" (400 error)

- The frontend fetch is missing the `x-publishable-api-key` header
- Must be included in **all** calls to `/store/*` endpoints

### Authorize.net error: "There was an error processing the payment data"

- The `opaqueData` token has expired (tokens expire after ~15 minutes)
- Or the `clientKey`/`apiLoginID` used to generate the token doesn't match the `apiLoginId`/`transactionKey` used on the backend

### Tax not calculated (total shows $0 in logs)

- The shipping address `province` must match exactly: `"us-fl"` for Florida, not `"FL"`
- See the FL province mapping in `route.ts`

### "Shipping profile mismatch" on cart completion

- A product has the "Long Item Ground" shipping profile but the selected option doesn't cover it
- The shipping resolution now uses the most expensive ground option as fallback, which should cover it
- Check which shipping profiles are assigned to the products in Medusa Admin

### Shipping providers: calculatePrice returns DOLLARS

Medusa's `calculatePrice` contract requires the returned `calculated_amount` to be in **dollars**.
Both `ground-shipping/service.ts` and `ups-ground-shipping/service.ts` store prices in the DB
as cents and divide by 100 before returning:

```typescript
// ✅ Correct — DB stores cents, calculatePrice must return dollars
const priceCents = settings.regular_ground_shipping_price  // e.g. 1499 for $14.99
const priceDollars = priceCents / 100
return { calculated_amount: priceDollars, is_calculated_price_tax_inclusive: false }
```

---

## Part 6: Testing

### Test Script

```bash
# From backend directory
NODE_OPTIONS="--dns-result-order=ipv4first" npx tsx src/scripts/test/test-fast-checkout.ts
```

The script:
1. Creates a cart with the real region ID (`reg_01KFS28SNF1MT1MRHRAFQ6ZGK1`)
2. Finds an in-stock variant and adds it
3. Selects a shipping option
4. **Calls Authorize.net's `securePaymentContainerRequest` API** to generate a real `opaqueData` token from the test card
5. Fires `POST /store/fast-checkout` and reports the result

### Test Card

```
Card:    4111 1111 1111 1111  (Visa)
Month:   12
Year:    2026
CVV:     123
```

> Works when Authorize.net is set to **Test Mode** in the dashboard.
> In test mode, real tokens are generated but charges are simulated.

### Production Checklist

- [ ] `AUTHORIZENET_ENVIRONMENT=production` in Railway env vars
- [ ] `PUBLISHABLE_API_KEY` set in Railway env vars
- [ ] `PUBLIC_MEDUSA_PUBLISHABLE_KEY` set in Vercel env vars
- [ ] `PUBLIC_AUTHORIZENET_CLIENT_KEY` set in Vercel env vars
- [ ] CORS allows production frontend domain in Medusa config
- [ ] Test end-to-end with real card in production ($1 test if needed)

---

## Part 7: Legacy Architecture (Reference Only)

> The old approach used a server-side Astro API route (`/api/checkout/initiate-payment.ts`)
> as a proxy. It made 5-6 sequential calls from Vercel → Railway per checkout.
> This caused 10-15 second checkout times and frequent 502 timeouts.
>
> The legacy file is preserved at:
> `frontend/src/pages/api/checkout/initiate-payment-legacy.ts.bak`

---

## Related Documentation

- `backend/docs/AUTHENTICATION_COMPLETE_GUIDE.md` — Customer login, JWT, session management
- `backend/docs/ADMIN_SETUP_CUSTOMER_PRICING.md` — Setting up price lists and customer groups
- `backend/docs/DYNAMIC_PRICING_ENDPOINT.md` — Custom price endpoint for product pages
- `backend/docs/CART_RACE_CONDITION_FIX.md` — Cart concurrency fix
- `backend/docs/FIXES/fast-checkout-architecture.md` — Detailed migration notes

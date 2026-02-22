# Checkout + Payment Implementation Guide

## 📋 Descripción del Documento

| Campo | Detalle |
|-------|---------|
| **Propósito** | Complete implementation guide for checkout and payment processing using Authorize.net as the payment provider in Medusa v2, integrated with the Astro storefront — from cart creation through order confirmation. |
| **Problemas que resuelve** | Medusa v2 payment integration with Authorize.net is not documented in the official docs. This covers the custom payment provider plugin, webhook handling, and the Astro frontend steps to render a payment form and handle 3DS redirects. |
| **Resultado esperado** | End-to-end checkout works: cart → shipping → payment → order creation. Authorize.net processes the card charge, the webhook confirms the order, and the customer receives a confirmation email. |
| **Scripts Creados** | `tests/test-cart-tax.ts`, `setup/setup-price-tiers.ts`, `verify/verify-wholesale-pricing.ts` |

## Medusa v2 + Authorize.net + Astro Storefront

> **Purpose:** This guide walks through the complete checkout and payment implementation as built for the EcoPowerTech storefront. If you're starting from scratch, follow these steps in order.

---

## Architecture Overview

```
[Customer Browser]
     │
     ▼
[Astro Frontend] ──── /api/checkout/* ──── [Medusa Backend :9000]
     │                (Astro server-side         │
     │                 API proxies)          [Payment Module]
     │                                           │
     ▼                                      [Authorize.net]
[React Components]                              (Sandbox/Prod)
 └── CheckoutLayout.tsx
 └── StepInfo.tsx        (Contact & Shipping Address)
 └── ShippingMethodSelector.tsx
 └── StepPayment.tsx + usePaymentForm.ts
```

---

## Part 1: Medusa Backend Setup

### 1.1 Install the Authorize.net Payment Provider

In `medusa-config.ts`:

```typescript
import { defineConfig } from '@medusajs/framework/utils'

export default defineConfig({
  modules: [
    {
      resolve: "@medusajs/medusa/payment",
      options: {
        providers: [
          {
            resolve: "./src/modules/authorize-net",  // custom provider path
            id: "authorize-net",
            options: {
              apiLoginId: process.env.AUTHORIZE_NET_API_LOGIN_ID,
              transactionKey: process.env.AUTHORIZE_NET_TRANSACTION_KEY,
              sandbox: process.env.NODE_ENV !== "production",
            }
          }
        ]
      }
    }
  ]
})
```

### 1.2 Required Environment Variables

```bash
# Authorize.net (note: prefix is AUTHORIZENET_ not AUTHORIZE_NET_)
AUTHORIZENET_API_LOGIN_ID=your_login_id
AUTHORIZENET_TRANSACTION_KEY=your_transaction_key
AUTHORIZENET_ENVIRONMENT=sandbox  # or 'production'

# Medusa
MEDUSA_BACKEND_URL=https://your-backend.railway.app
STORE_CORS=https://your-frontend.com
```

### 1.3 Create the Authorize.net Payment Provider Module

Path: `backend/src/modules/authorize-net/`

The provider must implement the `AbstractPaymentProvider` interface from `@medusajs/framework/utils`:

```typescript
// backend/src/modules/authorize-net/service.ts
import { AbstractPaymentProvider } from "@medusajs/framework/utils"

class AuthorizeNetProvider extends AbstractPaymentProvider {
  static identifier = "authorize-net"

  async initiatePayment(data) { /* ... */ }
  async authorizePayment(data, context) { /* ... */ }
  async capturePayment(data) { /* ... */ }
  async cancelPayment(data) { /* ... */ }
  async refundPayment(data, amount) { /* ... */ }
  async getPaymentStatus(data) { /* ... */ }
  async retrievePayment(data) { /* ... */ }
  async deletePayment(data) { /* ... */ }
  async updatePayment(data) { /* ... */ }
}
```

### 1.4 Admin: Create a Payment Provider in the Region

Via Medusa Admin UI:
1. **Settings → Regions** → Select your region
2. Under **Payment Providers**, enable "Authorize.net"
3. Save

---

## Part 2: The Checkout Flow (Step by Step)

The checkout has 3 steps, all in `frontend/src/features/checkout/`:

```
Step 1: Contact & Delivery  (StepInfo.tsx)
  └── Customer details, shipping address, delivery method
  └── Creates/updates the Medusa cart with shipping address + email

Step 2: Shipping Method  (ShippingMethodSelector.tsx)
  └── Fetches available shipping options from /store/shipping-options
  └── Adds selected shipping method to the cart

Step 3: Payment  (StepPayment.tsx + usePaymentForm.ts)
  └── Creates a payment collection
  └── Initiates a payment session
  └── Submits card data to Authorize.net
  └── Completes the cart → creates an order
```

---

## Part 3: Cart Lifecycle Before Checkout

Before checkout can happen, the cart must be properly set up:

### 3.1 Create Cart

```typescript
// POST /store/carts
const { cart } = await medusaPost('/store/carts', {
  region_id: 'reg_xxx',
  sales_channel_id: 'sc_xxx',
})
localStorage.setItem('ept_cart_v2:cartId', cart.id)
```

### 3.2 Associate Customer (Wholesale Pricing Critical!)

When a logged-in customer has a guest cart, call:

```typescript
// POST /store/carts/:id/customer  (Medusa v2.0.5+)
// sdk.store.cart.transferCart(cartId)
await medusaPost(`/store/carts/${cartId}/customer`, {}, {
  headers: { Authorization: `Bearer ${token}` }
})
```

> ⚠️ **CRITICAL:** This must happen BEFORE adding items if you want wholesale pricing.
> The `setPricingContext` hook reads `cart.customer_id` to inject customer groups.

### 3.3 Add Line Items

```typescript
// POST /store/carts/:id/line-items
const { cart } = await medusaPost(`/store/carts/${cartId}/line-items`, {
  variant_id: 'variant_xxx',
  quantity: 2
})
```

---

## Part 4: Step 1 — Contact & Delivery (StepInfo.tsx)

### 4.1 Update Cart with Email + Shipping Address

```typescript
// POST /store/carts/:id
await medusaPost(`/store/carts/${cartId}`, {
  email: 'customer@email.com',
  shipping_address: {
    first_name: 'John',
    last_name: 'Doe',
    address_1: '123 Main St',
    city: 'Miami',
    province: 'FL',
    postal_code: '33101',
    country_code: 'us',
    phone: '305-555-1234'
  }
})
```

### 4.2 Store Pickup (no shipping address needed)

For pickup, set a "Store Pickup" shipping method directly (see Part 5).

---

## Part 5: Step 2 — Shipping Method (ShippingMethodSelector.tsx)

### 5.1 Fetch Available Shipping Options

```typescript
// GET /store/shipping-options?cart_id=cart_xxx
const { shipping_options } = await medusaFetch(
  `/store/shipping-options?cart_id=${cartId}&fields=id,name,price_type,amount`
)
```

### 5.2 Add Shipping Method to Cart

```typescript
// POST /store/carts/:id/shipping-methods
await medusaPost(`/store/carts/${cartId}/shipping-methods`, {
  option_id: 'so_xxx',  // shipping option ID
})
```

> **Note:** Shipping price must be set up in Medusa Admin under **Settings → Shipping**.
> Use Flat Rate for standard shipping. Free Shipping can be implemented via a shipping option with amount 0 + minimum purchase rule.

---

## Part 6: Step 3 — Payment (StepPayment.tsx + usePaymentForm.ts)

This is the most complex step. Here's the exact sequence:

### 6.1 Create a Payment Collection

```typescript
// POST /store/payment-collections
const { payment_collection } = await medusaPost('/store/payment-collections', {
  cart_id: cartId
})
```

### 6.2 Initiate a Payment Session

```typescript
// POST /store/payment-collections/:id/payment-sessions
const { payment_collection } = await medusaPost(
  `/store/payment-collections/${paymentCollectionId}/payment-sessions`,
  { provider_id: 'pp_authorize-net_authorize-net' }
)
const session = payment_collection.payment_sessions[0]
```

### 6.3 Submit Payment via Custom Backend Endpoint

> **KEY DESIGN DECISION:** We do NOT process the payment directly from the frontend.
> Instead, the frontend sends card data to a custom Astro API endpoint (`/api/checkout/initiate-payment`),
> which does everything server-side. This keeps API keys secure.

**Frontend calls:**
```typescript
// POST /api/checkout/initiate-payment
const result = await fetch('/api/checkout/initiate-payment', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    cartId,
    paymentSessionId: session.id,
    cardNumber: form.cardNumber,
    expiryMonth: form.expiryMonth,
    expiryYear: form.expiryYear,
    cvv: form.cvv,
    amount: totalAmount,
    customerEmail: form.email,
    billingAddress: { /* ... */ }
  })
})
const { orderId } = await result.json()
```

**Astro API endpoint does:**
```typescript
// frontend/src/pages/api/checkout/initiate-payment.ts
export const POST: APIRoute = async ({ request }) => {
  const body = await request.json()

  // 1. Charge the card via Authorize.net directly
  const authNetResult = await chargeCard({
    apiLoginId: import.meta.env.AUTHORIZE_NET_API_LOGIN_ID,
    transactionKey: import.meta.env.AUTHORIZE_NET_TRANSACTION_KEY,
    amount: body.amount,
    cardNumber: body.cardNumber,
    // ...
  })

  if (!authNetResult.success) {
    return new Response(JSON.stringify({ error: authNetResult.message }), { status: 400 })
  }

  // 2. Add shipping method (if not already done)
  await medusaPost(`/store/carts/${body.cartId}/shipping-methods`, {
    option_id: shippingOptionId
  })

  // 3. Complete the cart → creates the order in Medusa
  const { type, order } = await medusaPost(`/store/carts/${body.cartId}/complete`, {})

  if (type !== 'order') {
    throw new Error('Cart completion failed')
  }

  // 4. Capture payment on the order
  await medusaPost(`/admin/orders/${order.id}/fulfillments`, {}, adminHeaders)
  // OR use payment capture endpoint:
  // await medusaPost(`/admin/payments/${paymentId}/capture`, {}, adminHeaders)

  return new Response(JSON.stringify({ orderId: order.id }), { status: 200 })
}
```

### 6.4 Authorize.net API Call (Core Charge Logic)

```typescript
async function chargeCard(config) {
  const endpoint = config.sandbox
    ? 'https://apitest.authorize.net/xml/v1/request.api'
    : 'https://api.authorize.net/xml/v1/request.api'

  const payload = {
    createTransactionRequest: {
      merchantAuthentication: {
        name: config.apiLoginId,
        transactionKey: config.transactionKey
      },
      transactionRequest: {
        transactionType: 'authCaptureTransaction',
        amount: config.amount.toFixed(2),
        payment: {
          creditCard: {
            cardNumber: config.cardNumber,
            expirationDate: `${config.expiryMonth}/${config.expiryYear}`,
            cardCode: config.cvv
          }
        },
        billTo: {
          firstName: config.billingAddress.firstName,
          lastName: config.billingAddress.lastName,
          address: config.billingAddress.address,
          city: config.billingAddress.city,
          state: config.billingAddress.state,
          zip: config.billingAddress.zip,
          country: 'US'
        },
        customerIP: config.customerIP
      }
    }
  }

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  })

  const data = await response.json()
  const result = data.transactionResponse

  return {
    success: result?.responseCode === '1',
    transactionId: result?.transId,
    message: result?.messages?.[0]?.description || 'Unknown error'
  }
}
```

### 6.5 Complete Cart → Create Order

```typescript
// POST /store/carts/:id/complete
const { type, order } = await medusaPost(`/store/carts/${cartId}/complete`, {})

// type === 'order' means success
// type === 'cart' means something failed (check cart.metadata for errors)
```

---

## Part 7: After Payment — Order Confirmation

### 7.1 Clear the Cart (Frontend)

```typescript
// Clear cart from localStorage and state after successful order
localStorage.removeItem('ept_cart_v2:cartId')
medusaCart.set(null)
cartItems.set({})
```

### 7.2 Redirect to Order Confirmation

```typescript
window.location.href = `/order-confirmation?orderId=${orderId}`
```

### 7.3 Order Confirmation Page

```astro
// frontend/src/pages/order-confirmation.astro
const orderId = Astro.url.searchParams.get('orderId')
// Fetch order details via /store/orders/:id
// Display order summary to customer
```

---

## Part 8: Wholesale Pricing in Cart (Critical for B2B)

### Problem

Medusa v2 does NOT automatically apply customer group price lists when adding items to the cart. The `unit_price` is set at the time of adding, without considering price lists, unless you inject context.

### Solution: `setPricingContext` Workflow Hooks

File: `backend/src/workflows/hooks/set-cart-pricing-context.ts`

```typescript
import { addToCartWorkflow, updateLineItemInCartWorkflow } from "@medusajs/medusa/core-flows"
import { StepResponse } from "@medusajs/workflows-sdk"
import { Modules } from "@medusajs/framework/utils"

// Hook for ADDING items
addToCartWorkflow.hooks.setPricingContext(
    async ({ cart }, { container }) => {
        if (!cart?.customer_id) return new StepResponse({})

        const customerModule = container.resolve(Modules.CUSTOMER)
        const customer = await customerModule.retrieveCustomer(cart.customer_id, {
            relations: ["groups"]
        })

        if (!customer.groups?.length) return new StepResponse({})

        return new StepResponse({
            customer_group_id: customer.groups.map(g => g.id)
        })
    }
)

// Hook for UPDATING quantity (same logic)
updateLineItemInCartWorkflow.hooks.setPricingContext(/* same */ )
```

> **Required middleware** in `backend/src/api/middlewares.ts`:
> ```typescript
> { matcher: "/store/carts*", middlewares: [authenticate("customer", ["session", "bearer"], { allowUnauthenticated: true })] }
> ```

### Pending: Guest Cart → Login Price Refresh

When a guest adds items (retail prices) then logs in, existing prices are NOT re-calculated.
**TODO:** Add `refreshCartItemsWorkflow.hooks.setPricingContext` + call it after login.

---

## Part 9: Common Gotchas & Debugging

### Cart Completion Returns `type: "cart"` Instead of `type: "order"`

This means the cart is missing required data. Check:
- [ ] Email is set on the cart
- [ ] Shipping address is complete (country_code is required)
- [ ] Shipping method is added
- [ ] Payment session exists and is authorized

### Authorize.net Returns Error Code E00003

Usually means malformed request. Check:
- `expirationDate` format must be `MM/YYYY` or `MMYY` — test both
- `amount` must be a string with 2 decimal places: `"56.42"`
- Sandbox credentials only work with sandbox endpoint (`apitest.authorize.net`)

### Prices Not Updating to Wholesale After Login

1. Verify customer is in a Customer Group in Medusa Admin
2. Verify the Price List has a condition rule for `customer.group.id`
3. Check backend logs for `[PRICING-HOOK] 👑 Wholesale customer detected`
4. Make sure `cart.customer_id` is set BEFORE calling `addToCartWorkflow`

### CORS Errors on Payment Call

The Authorize.net API requires HTTPS. For local development:
- Generate a self-signed cert and run Astro with HTTPS
- OR proxy through your backend which has a valid cert

### Payment Captured But Order Not Created

The payment capture and cart completion must happen in the right order:
1. First complete the cart: `POST /store/carts/:id/complete`
2. Then capture payment via Admin API: `POST /admin/payments/:id/capture`

Reversing this order can leave the transaction in an inconsistent state.

---

## Part 10: Testing Checklist

### Local Testing (Sandbox Mode)

Use Authorize.net test card numbers:
- Card: `4111111111111111` (Visa test)
- Expiry: any future date
- CVV: any 3 digits

### Production Checklist

- [ ] Switch `AUTHORIZENET_API_LOGIN_ID` and `AUTHORIZENET_TRANSACTION_KEY` to live credentials
- [ ] Set `AUTHORIZENET_ENVIRONMENT=production` in production environment
- [ ] Verify CORS allows production frontend domain
- [ ] Test order creation end-to-end with a real card ($1 test charge)
- [ ] Verify order appears in Medusa Admin
- [ ] Verify customer receives confirmation email (if Sendgrid configured)
- [ ] Verify customer can view order in `/account/orders`

---

## Related Documentation

- `backend/docs/AUTHENTICATION_COMPLETE_GUIDE.md` — Customer login, JWT, session management
- `backend/docs/ADMIN_SETUP_CUSTOMER_PRICING.md` — Setting up price lists and customer groups in Admin
- `backend/docs/DYNAMIC_PRICING_ENDPOINT.md` — Custom price endpoint for product pages
- `backend/WHOLESALE_PRICING.md` — Scripts to add/remove wholesale prices
- `backend/docs/GETTING_PRODUCT_PRICES.md` — How product prices are fetched
- `SHIPPING_IMPLEMENTATION_GUIDE.md` — Shipping options setup

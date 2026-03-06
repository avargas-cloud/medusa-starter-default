# Draft Orders — Advanced UI & Estimate System
# The Ultimate & Complete Guide

| Campo | Detalle |
|-------|---------|
| **Propósito** | Advanced Draft Orders admin page — a complete replacement for Medusa's native draft order detail view, featuring inline item editing, dual-pricing (Default/Wholesale), tax management, store pickup, and a full B2B Estimate workflow with PDF generation and email delivery. |
| **Última revisión** | 2026-03-06 |

## Resumen Ejecutivo

✅ **Vista avanzada** en `/app/draft-orders-advanced/:id` con edición de items en tiempo real
✅ **Dual pricing** — precio Default (retail) o Wholesale por ítem, detectado automáticamente por customer group
✅ **Tax management** — FL 7% o Tax Exempt, persistido en tablas nativas de Medusa
✅ **Store Pickup** — auto-rellena la dirección de la tienda al seleccionar esta opción
✅ **Estimate PDF** — generado con Puppeteer + Chrome (`/usr/bin/google-chrome`)
✅ **Print in Store** — iframe oculto, sin abrir nuevas pestañas
✅ **Email via SendGrid** — PDF adjunto
✅ **Per-field Customer Defaults** — botones azules cuando el valor difiere del default del customer
✅ **Activity Timeline** — "Email Sent" con usuario atribuido
✅ **Auto-status** — `Created` → `Sent` automáticamente al enviar correo
✅ **QB Sync** — crea/actualiza Estimate en QuickBooks Desktop vía QB Bridge; convierte a Sales Order al completar el draft
✅ **Web Order → QB Sales Order** — precio correcto (unit_price desde `order_line_item`, no `order_item`)
✅ **Cancel Order → QB Closed** — `order.canceled` cierra Sales Order y/o voidea Invoice en QB automáticamente
✅ **Convert-Force endpoint** — `/admin/draft-orders/:id/convert-force` con fallback de reservaciones
✅ **allow_backorder=true** — todos los product variants actualizados para conversión con 0 stock

---

## Table of Contents

1. [File Structure](#1-file-structure)
2. [Custom Backend Endpoints](#2-custom-backend-endpoints)
3. [Hook Architecture](#3-hook-architecture)
4. [Main Page: page.tsx](#4-main-page-pagetsx)
5. [Inline Items Table & Pricing](#5-inline-items-table--pricing)
6. [Taxes (InlineTaxes)](#6-taxes-inlinetaxes)
7. [Shipping (InlineShipping)](#7-shipping-inlineshipping)
8. [Estimate Details Widget](#8-estimate-details-widget)
9. [Customer Widgets](#9-customer-widgets)
10. [Print in Store](#10-print-in-store)
11. [Send Estimate Modal](#11-send-estimate-modal)
12. [PDF Generation & Email](#12-pdf-generation--email)
13. [Estimate HTML Layout Rules](#13-estimate-html-layout-rules)
14. [QuickBooks Sync](#14-quickbooks-sync)
15. [PostgreSQL Tables Reference](#15-postgresql-tables-reference)
16. [Environment Variables](#16-environment-variables)
17. [Known Issues & Gotchas](#17-known-issues--gotchas)
18. [Inventory & Backorder Architecture](#18-inventory--backorder-architecture)

---

## 1. File Structure

```
backend/src/
│
├── api/admin/draft-orders/[id]/
│   ├── send-estimate/route.ts         ← HTML template + PDF gen + email
│   ├── variant-prices/route.ts        ← Default + Wholesale prices per variant
│   ├── compute-tax/route.ts           ← Calculates + persists tax
│   ├── add-item-force/route.ts        ← Add item bypassing Medusa validation
│   ├── update-item-force/route.ts     ← Update qty/price bypassing validation
│   ├── delete-item-force/route.ts     ← Remove item bypassing validation
│   ├── add-shipping-force/route.ts    ← Add shipping bypassing validation
│   ├── remove-shipping/[mid]/route.ts ← Remove shipping method
│   └── convert-force/route.ts        ← Convert draft → order with backorder fallback
│
├── api/admin/quickbooks/
│   ├── draft-order/route.ts           ← POST: sync draft order as QB Estimate
│   ├── order/route.ts                 ← POST: sync order as QB Sales Order (or convert Estimate→SO)
│   └── logs/route.ts                  ← GET: activity log entries
│
└── admin/
    ├── routes/draft-orders-advanced/
    │   ├── page.tsx                          ← Draft order LIST (index page)
    │   └── [id]/
    │       ├── page.tsx                      ← Main DETAIL page
    │       ├── types.ts                      ← Shared TypeScript types
    │       ├── helpers.ts                    ← Utilities (fmt, addrToLines, getMissingEstimateFields)
    │       ├── hooks/
    │       │   ├── use-draft-order-detail.tsx ← Orchestrator: assembles all sub-hooks
    │       │   ├── use-order-fetch.ts         ← Order data fetch + timeline + customer enrichment
    │       │   ├── use-order-items.ts         ← Item CRUD + variant search + qty/price state
    │       │   ├── use-order-modal.ts         ← All modal/drawer logic (address, customer, etc.)
    │       │   ├── use-order-shipping.ts      ← Shipping CRUD
    │       │   ├── use-order-actions.ts       ← QB sync, convert, delete, status change
    │       │   ├── use-order-page-state.ts    ← customerPrices + inlineShippingOptions
    │       │   └── use-page-derived.ts        ← Derived values (isWholesale, estimateInfo, totals)
    │       └── components/
    │           ├── EstimateInfoBlock.tsx     ← Rep/Terms/LeadTime/Notes form
    │           ├── SendEstimateModal.tsx     ← Email modal with live preview
    │           ├── InlineItemsTable.tsx      ← Editable items table
    │           ├── PriceCombobox.tsx         ← Default/Wholesale price selector
    │           ├── InlineTaxes.tsx           ← Tax mode selector + compute
    │           ├── InlineShipping.tsx        ← Shipping method selector
    │           ├── InlineNotes.tsx           ← Estimate notes field
    │           ├── OrderHeader.tsx           ← Top bar (Print/Send/Convert buttons)
    │           ├── OrderSidebar.tsx          ← QB sync panel + timeline
    │           ├── CustomerBlock.tsx         ← Customer + address display
    │           ├── OrderTotals.tsx           ← Computed totals display
    │           ├── OrderDrawers.tsx          ← All edit modals (address, customer, email, etc.)
    │           └── PromotionsBlock.tsx       ← Discount codes
    │
    └── widgets/
        ├── customer-estimate-defaults.tsx   ← Customer page: default Rep/Terms
        ├── customer-tax-exempt.tsx          ← Customer page: Tax Exempt + doc upload
        └── quickbooks-order-widget.tsx      ← Order detail page: QB Sales Order sync
```

---

## 2. Custom Backend Endpoints

### `GET /admin/draft-orders/:id/variant-prices`

Returns all available prices for a set of variants — default retail + active price lists.

**Query:** `?variant_ids[]=v1&variant_ids[]=v2`

**Response:**
```json
{
  "prices": {
    "variant_01ABC": {
      "default": { "amount": 56.75, "currency_code": "usd" },
      "list": [
        {
          "amount": 51.25,
          "currency_code": "usd",
          "price_list_id": "plist_01KFTSDZZNTQRSYNMB4YST1HYA",
          "price_list_name": "Wholesale Pricing"
        }
      ]
    }
  }
}
```

> ⚠️ **Prices are in dollars (not cents).** Raw SQL via `pg.Pool`. Joins `product_variant_price_set` → `price` → `price_list` using `pl.title` (NOT `pl.name` — that column doesn't exist in v2).

---

### `POST /admin/draft-orders/:id/add-item-force`

Adds a variant to the draft order, bypassing Medusa's native stock/validation layer.

**Body:** `{ variant_id: string, quantity: number, unit_price: number }`

Uses `POST /admin/orders/:id/items` → confirms the change via `POST /admin/orders/:id/changes/confirm`.

---

### `POST /admin/draft-orders/:id/update-item-force`

Updates quantity and/or unit price of an existing line item.

**Body:** `{ line_item_id: string, quantity?: number, unit_price?: number }`

Flow: fetches current order change or creates one → amends item → confirms.

> ⚠️ **price in dollars** — the endpoint receives dollars and converts to cents for Medusa's internal API.

---

### `POST /admin/draft-orders/:id/delete-item-force`

Removes a line item.

**Body:** `{ line_item_id: string }`

---

### `GET|POST /admin/draft-orders/:id/compute-tax`

**GET** — Returns computed tax (no write).
**POST** — Writes tax to Medusa's native tables.

**POST body:** `{ "mode": "florida" | "exempt" }`

**Backend behavior on POST:**
1. Gets `DISTINCT` active `item_id`s from the order
2. Hard-DELETEs existing `code='manual'` tax lines
3. Inserts one `order_line_item_tax_line` per item (prorated)
4. Updates `order_summary.totals` JSONB: sets `tax_total`, recalculates `current_order_total`

---

### `POST /admin/draft-orders/:id/send-estimate`

Generates PDF (Puppeteer) and sends via SendGrid.

**Body:** `{ "to": "email@example.com", "subject": "Estimate #1068 from EcoPowerTech" }`

**GET** `?mode=print` — Returns full estimate HTML + auto-print script for iframe.
**GET** `?mode=email` — Returns HTML for preview only.

---

### `POST /admin/draft-orders/:id/convert-force`

Converts draft order to regular order with inventory backorder fallback.

**Flow:**
1. Calls Medusa native `/admin/draft-orders/:id/complete`
2. If inventory error: creates reservations with `allow_backorder: true` for each item, then retries
3. Reads the true order total via `GET /admin/orders/:id?fields=total,...` and patches payment collection amount

> ⚠️ **Does NOT call QB sync directly.** The `order.placed` event emitted by Medusa's conversion workflow is picked up by `qb-order-subscriber.ts`, which creates the QB Sales Order automatically. Calling QB manually here used to cause **duplicate Sales Orders** and has been removed.

---

### `POST /admin/quickbooks/draft-order`

Manually triggers QB Estimate creation (first sync) or update (re-sync with `force: true`).

**Body:** `{ orderId: string, force?: boolean }`

---

### `POST /admin/quickbooks/order`

Manually triggers QB Sales Order sync for a confirmed order. If the order originated from a draft that already has a QB Estimate (`qb_estimate_txn_id` in metadata), converts the Estimate to a Sales Order in QB. Otherwise creates a new Sales Order directly.

**Body:** `{ orderId: string }`

**Saves to order metadata:** `qb_sales_order_txn_id`, `qb_sales_order_ref`, `qb_payment_txn_id`, `qb_invoice_txn_id`

---

### `GET /admin/estimate-options`

Returns dropdown options:
```json
{
  "payment_terms": ["Due on Receipt", "Net 15", "Net 30", "Net 60"],
  "lead_times": ["In stock as of date on quote", "1-2 weeks", "2-4 weeks", "4-6 weeks"],
  "order_types": ["Regular Order", "Special Order", "Backorder", "Drop Ship"]
}
```

---

## 3. Hook Architecture

`use-draft-order-detail.tsx` is a **thin orchestrator** — it assembles 7 focused sub-hooks and exposes a single unified return object to `page.tsx`.

```typescript
export const useDraftOrderDetail = (id: string | undefined) => {
    const fetch_  = useOrderFetch(id, ..., setEstimateStatus)
    const items   = useOrderItems({ id, order, setOrder })
    const modal_  = useOrderModal({ id, order, setItemQtys, setItemPrices, fetchOrder })
    const shipping = useOrderShipping({ id, setOrder, ... })
    const actions = useOrderActions({ id, order, estimateStatus, patchOrder })
    // returns merged object from all hooks
}
```

### Sub-Hook Responsibilities

| Hook | Owns |
|------|------|
| `use-order-fetch.ts` | Fetch order, timeline, current user, customer enrichment |
| `use-order-items.ts` | Variant search, add/update/remove items, qty/price state |
| `use-order-modal.ts` | All edit modals (address, customer, email, shipping, metadata) |
| `use-order-shipping.ts` | Add/remove/replace/update shipping methods |
| `use-order-actions.ts` | QB sync, convert to order, delete, status change |
| `use-order-page-state.ts` | Customer variant prices, inline shipping options |
| `use-page-derived.ts` | `isWholesale`, `estimateInfo`, computed totals |

### Data Fetch Strategy (`use-order-fetch.ts`)

The hook does a **parallel fetch** on every load:

```typescript
const [oRes, dRes] = await Promise.all([
  // Primary: /admin/orders — prices in DOLLARS, rich customer/address/items data
  fetch(`/admin/orders/${id}?fields=+customer.*,+customer.groups,+shipping_address.*,+items.*,...`),
  // Secondary: /admin/draft-orders — prices in CENTS, fresh preview totals
  fetch(`/admin/draft-orders/${id}`),
])
```

After loading, a **separate customer fetch** enriches `order.customer` with full groups + metadata (the order API may not expand all customer fields):

```typescript
const custRes = await fetch(`/admin/customers/${customerId}?fields=*groups,metadata,...`)
if (custRes.ok) {
    const { customer: fullCust } = await custRes.json()
    merged.customer = { ...(merged.customer ?? {}), ...fullCust }
    setOrder({ ...merged })
}
```

**Price normalization:** draft-orders returns cents; orders returns dollars. Everything is normalized to dollars:
```typescript
const normalizePrice = (cents: number) => cents > 100 ? cents / 100 : cents
// qty=0 items are soft-deleted — filter them out
merged.items = merged.items.filter((item: any) => item.quantity > 0)
```

### Stale Closure Fix in `use-order-items.ts`

React's `useState` closures get "stale" when auto-save fires 3 seconds after a price change. The fix uses `useRef` to always read the latest value:

```typescript
const itemQtysRef   = useRef<Record<string, number>>({})
const itemPricesRef = useRef<Record<string, string>>({})

// Wrapper setters keep refs in sync with state
const setItemQtysSafe = (v: any) => {
    const next = typeof v === "function" ? v(itemQtysRef.current) : v
    itemQtysRef.current = next
    setItemQtys(next)
}
const setItemPricesSafe = (v: any) => {
    const next = typeof v === "function" ? v(itemPricesRef.current) : v
    itemPricesRef.current = next
    setItemPrices(next)
}

// handleUpdateItem always reads the LATEST value (never a stale closure)
const handleUpdateItem = async (itemId: string) => {
    const qty   = itemQtysRef.current[itemId] ?? 1
    const price = parseFloat(itemPricesRef.current[itemId] ?? "0")
    // POST to /admin/draft-orders/:id/update-item-force
}
```

---

## 4. Main Page: page.tsx

**File:** `routes/draft-orders-advanced/[id]/page.tsx`

### Page Layout
```
┌─────────────────────────────────────────────────────────┬──────────────────┐
│  OrderHeader (Print/Send/Convert/Delete buttons)        │                  │
│  CustomerBlock (customer info + addresses)              │                  │
│  EstimateInfoBlock (Rep/OrderType/LeadTime/Terms/Notes) │   OrderSidebar   │
│  Items (InlineItemsTable — search + edit + price)       │   (QB Sync +     │
│  PromotionsBlock (discount codes)                       │    Estimate      │
│  Notes (InlineNotes)                                    │    Status +      │
│  Shipping (InlineShipping)                              │    Timeline)     │
│  Taxes (InlineTaxes)                                    │                  │
│  OrderTotals                                            │                  │
└─────────────────────────────────────────────────────────┴──────────────────┘
```

### Wholesale Detection

```typescript
// page.tsx delegates to use-page-derived.ts or computes inline:
const isWholesale = (() => {
    const cust = order.customer as any
    return (cust?.groups ?? []).some((g: any) => (g.name ?? "").toLowerCase().includes("wholesale")) ||
        (cust?.metadata?.price_level as string ?? "").toLowerCase().includes("wholesale")
})()
```

> **Customer groups require the separate customer fetch** — `order.customer.groups` is NOT reliably populated from the orders API alone. See Section 3.

### Tax Trigger Pattern

After any item mutation, taxes must refresh (tax base changed):

```typescript
const [taxTrigger, setTaxTrigger] = useState(0)
const bumpTax = useCallback(() => setTaxTrigger(n => n + 1), [])

const handleAddItemWithTax = useCallback(async (variantId, overridePrice?) => {
    await s.handleAddItem(variantId, overridePrice)
    bumpTax()
}, [s.handleAddItem, bumpTax])
```

`InlineTaxes` re-fetches whenever `triggerKey` changes.

### Estimate Info Initialization

Customer defaults pre-fill the form if no estimate-specific values exist:

```typescript
const estimateInitialInfo = {
    rep:          (order.metadata?.estimate_rep          ?? order.customer?.metadata?.default_rep          ?? "") as string,
    orderType:    (order.metadata?.estimate_order_type   ?? order.customer?.metadata?.default_order_type   ?? "") as string,
    leadTime:     (order.metadata?.estimate_lead_time    ?? order.customer?.metadata?.default_lead_time    ?? "") as string,
    paymentTerms: (order.metadata?.estimate_payment_terms ?? order.customer?.metadata?.default_payment_terms ?? "") as string,
    project:      (order.metadata?.estimate_project      ?? "") as string,
}
```

### Action Gating

Both Print and Send are gated by `getMissingEstimateFields()` in `helpers.ts`:

```typescript
// helpers.ts
export function getMissingEstimateFields(info: EstimateInfo): string[] {
    return REQUIRED_FIELDS               // [rep, orderType, leadTime, paymentTerms]
        .filter(f => !info[f.key]?.trim())
        .map(f => f.label)
}
// Note: project is NOT required
```

---

## 5. Inline Items Table & Pricing

**File:** `components/InlineItemsTable.tsx`

### Item Search

Hits `/admin/product-variants?q=...` then enriches with product thumbnails and inventory levels.

### Price Selection on Add (Auto-Wholesale)

When a user clicks a search result:
```typescript
const contractorP = customerPrices[v.id]?.list?.[0]  // First wholesale price
const defaultP    = customerPrices[v.id]?.default     // Retail price

// If customer is wholesale AND wholesale price exists → use wholesale
const price = (customerIsWholesale && contractorP) ? contractorP : (defaultP ?? contractorP)
handleAddItem(v.id, price?.amount)
```

### Visual Indicator in Search Dropdown

The correct price for the customer gets **blue text + ✓**:
```tsx
// defaultP row
className={`block ${!customerIsWholesale ? "text-ui-fg-interactive font-medium" : "text-ui-fg-muted"}`}
{!customerIsWholesale && " ✓"}

// contractorP row (wholesale)
className={`block ${customerIsWholesale ? "text-ui-fg-interactive font-medium" : "text-ui-fg-muted"}`}
{customerIsWholesale && " ✓"}
```

### PriceCombobox (`components/PriceCombobox.tsx`)

Each item row has a price input with optional dropdown for multiple price tiers:

```
[  $56.75  ▾ ]
  ── Default ──────────
  ● $56.75  (Retail)
  ── Wholesale ────────
    $51.25  (Wholesale Pricing)
```

- Auto-saves after **3 seconds** of inactivity (debounce)
- Saves **immediately** on blur
- Shows `saving…` and `✓` indicators
- On change: calls `setItemPrices` (via `setItemPricesSafe`) + starts debounce timer

---

## 6. Taxes (InlineTaxes)

**File:** `components/InlineTaxes.tsx`

Segmented button: **Florida (7%)** | **Tax Exempt**

```typescript
const handleModeChange = async (newMode: TaxMode) => {
    // 1. Optimistic update (instant feedback)
    const optimisticAmount = newMode === "exempt" ? 0
        : Math.round(tax.subtotal * 7 / 100 * 100) / 100
    setTax(prev => ({ ...prev, mode: newMode, amount: optimisticAmount }))
    onTaxChange?.(optimisticAmount)

    // 2. Persist to server
    await fetch(`/admin/draft-orders/${orderId}/compute-tax`, {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: newMode }),
    })

    // 3. Re-fetch for exact server amount
    await fetchTax()
}
```

---

## 7. Shipping (InlineShipping)

**File:** `components/InlineShipping.tsx`

### Store Pickup Detection

```typescript
const PICKUP_KEYWORDS = ["pickup", "store pickup", "local pickup", "in store", "in-store"]
const isPickup = (name: string) => PICKUP_KEYWORDS.some(k => name.toLowerCase().includes(k))
```

When Store Pickup selected: auto-sets amount to $0.

### Saving Indicator

The "Saving..." indicator shows **next to the method name in the header row**, NOT by replacing the price input. The price input stays visible but is **disabled** while saving. This prevents the price from being hidden.

```tsx
// Header row
<span className="text-xs text-ui-fg-muted">{saving ? "Saving..." : methodName}</span>

// Price input — always visible
<input
    disabled={saving}
    value={priceState[method.id]?.value ?? ""}
    ...
/>
```

### Remove (Optimistic)

Removes from UI immediately, then DELETEs from server. Parent gets `onRemoved` callback.

---

## 8. Estimate Details Widget

**File:** `components/EstimateInfoBlock.tsx`

### Form Fields

| Label | `EstimateInfo` key | Saved to metadata as |
|-------|--------------------|----------------------|
| Rep | `rep` | `estimate_rep` |
| Order Type | `orderType` | `estimate_order_type` |
| Lead Time | `leadTime` | `estimate_lead_time` |
| Payment Terms | `paymentTerms` | `estimate_payment_terms` |
| Project Name | `project` | `estimate_project` |

> Notes: managed by `InlineNotes` → saved as `estimate_notes`

### Auto-save

Every field change POSTs to `/admin/draft-orders/:id` with full metadata object.

### Per-Field Customer Default Buttons

When a field differs from `customerDefaults[key]`, a blue button appears:

```tsx
{isDifferentFromDefault(key) && (
    <button onClick={() => saveFieldDefault(key)} className="text-[10px] text-blue-500">
        {isSaving ? "Saving…" : "↑ Set as customer default"}
    </button>
)}
```

> ⚠️ **NEVER use `window.confirm()` in Medusa Admin.** Silently blocked inside the admin's iframe context. Always use React state + button patterns.

---

## 9. Customer Widgets

### `customer-estimate-defaults.tsx`

**Zone:** `customer.details.after`

Manages default estimate values in customer metadata: `default_rep`, `default_order_type`, `default_lead_time`, `default_payment_terms`. These pre-fill new estimates for that customer.

### `customer-tax-exempt.tsx`

**Zone:** `customer.details.after`

| UI | Metadata Key | Type |
|----|-------------|------|
| Tax Exempt toggle | `is_tax_exempt` | `"Yes"` or `"No"` |
| Tax ID / Certificate # | `tax_id` | string |
| Upload certificate | `tax_exempt_doc_url` | Minio public URL |
| (filename display) | `tax_exempt_doc_name` | string |

File upload: `FileReader` → base64 → `POST /admin/uploads` (Minio) → URL saved to metadata.

### `quickbooks-order-widget.tsx`

**Zone:** `order.details.before`

Shows on confirmed orders (not draft). Displays QB Sales Order Number, TxnID, Payment TxnID, Invoice TxnID. Provides a **"Re-sync Sales Order"** button (calls `POST /admin/quickbooks/order`) for manual re-sync or estimate-to-SO conversion.

**Auto-polling:** The widget polls `GET /admin/orders/:id?fields=metadata` every **8 seconds** while `qb_sales_order_txn_id` is absent, displaying a ⏳ badge. Stops automatically once the txnId is detected. A manual **↻ Refresh** button is also available in the header.

---

## 10. Print in Store

```typescript
// Hidden off-screen iframe — no new tab
const iframe = document.createElement("iframe")
iframe.style.cssText = "position:fixed;top:-9999px;left:-9999px;width:1px;height:1px;border:0;"
document.body.appendChild(iframe)
iframe.onload = () => setTimeout(() => document.body.removeChild(iframe), 120_000)
iframe.src = `/admin/draft-orders/${id}/send-estimate?mode=print`
```

The HTML at `?mode=print` has an auto-print script:
```html
<script>
  window.addEventListener('load', () => setTimeout(() => window.print(), 300))
</script>
```

> ⚠️ Do NOT add `sandbox` attribute to the iframe — it would block `window.print()`.

---

## 11. Send Estimate Modal

**File:** `components/SendEstimateModal.tsx`

Full-screen overlay:
- **Left panel (280px):** To email, Subject, Send button
- **Right panel:** Live estimate preview (iframe)

**Subject format:** `Estimate #1068 from EcoPowerTech`
❌ Never include dollar amount in subject.

Preview uses `contentDocument.write()` so it loads instantly without a second network round-trip:
```typescript
const doc = iframeRef.current.contentDocument
doc.open(); doc.write(previewHtml); doc.close()
```

---

## 12. PDF Generation & Email

**File:** `api/admin/draft-orders/[id]/send-estimate/route.ts`

### Puppeteer PDF

```typescript
const browser = await puppeteer.launch({
    executablePath: process.env.CHROME_EXECUTABLE_PATH ?? "/usr/bin/google-chrome",
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    headless: true,
})
const page = await browser.newPage()
await page.setContent(html, { waitUntil: "networkidle0" })
const pdfBuffer = await page.pdf({
    format: "Letter",
    margin: { top: "12mm", bottom: "12mm", left: "14mm", right: "14mm" },
    printBackground: true,   // ← renders background-color on cells
})
await browser.close()
```

Uses system Chrome instead of bundled Chromium — saves ~200MB and avoids Ubuntu library errors.

### Logo Strategy

| Context | Method |
|---------|--------|
| PDF (Puppeteer) | `data:image/png;base64,LOGO_B64` constant |
| Email body | Public HTTPS Minio URL |

> Gmail blocks `data:` URIs — always use public HTTPS in email.

### SendGrid

```typescript
const msg = {
    to: customerEmail,
    from: { email: fromEmail, name: "EcoPowerTech" },
    subject: emailSubject,
    html: emailBodyHtml,
    attachments: [{
        content: pdfBuffer.toString("base64"),
        filename: `${estNum}.pdf`,
        type: "application/pdf",
        disposition: "attachment",
    }],
}
await sgMail.send(msg)
```

**Resilient delivery:** If Puppeteer fails, the email sends without the PDF attachment.

### Rep Initials Mapping

```typescript
const QB_REP_MAP: Record<string, string> = {
    "a.vargas@ecopowertech.com":  "AVP",
    "a.guedes@ecopowertech.com":  "AG",
    "j.vargas@ecopowertech.com":  "JTV",
    "j.peralta@ecopowertech.com": "JCP",
    "m.perez@ecopowertech.com":   "MFP",
    "a.arenas@ecopowertech.com":  "AAA",
}
// To add a rep: add email → initials here
```

---

## 13. Estimate HTML Layout Rules

### Header (Logo | Company Info | "Estimate" title)

```html
<table width="100%" cellpadding="0" cellspacing="0">
  <tr>
    <td style="vertical-align:middle; width:36%;">
      <img src="${LOGO_DATA_URI}" alt="EcoPowerTech" style="height:36px;" />
      <span style="font-size:14px; font-weight:800;">ECOPOWERTECH</span>
    </td>
    <!-- Company info: 3 SEPARATE divs (never one line — would wrap) -->
    <td style="text-align:center; font-size:9px; color:#555; width:34%;">
      <div>Ecopowertech Inc.</div>
      <div>2760 W 84th St, Unit 4, Hialeah, FL 33016</div>
      <div>Phone: (305) 851-7028 &nbsp;·&nbsp; info@ecopowertech.com</div>
    </td>
    <td style="text-align:right; width:30%;">
      <div style="font-size:22px; font-weight:900;">Estimate</div>
      <div style="font-size:9px; color:#6b7280;">only valid for 30 days</div>
    </td>
  </tr>
</table>
```

### 3-Block Address Header (To / Ship To / Estimate Details)

**Rule: Single `<tr>`, 3 `<td>`s. Browser auto-equalizes heights. Right columns use `border-left:0` to prevent double lines.**

```html
<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
  <tr>
    <!-- Column 1: To — full border -->
    <td width="33.33%" style="border:1px solid #d1d5db; vertical-align:top; padding:0;">
      <div style="border-bottom:1px solid #d1d5db; padding:3px 7px; background:#f3f4f6; font-weight:700;">To</div>
      <div style="padding:6px 8px;">[company + address lines]</div>
    </td>

    <!-- Column 2: Ship To — border-left:0 prevents double line between col 1 & 2 -->
    <td width="33.33%" style="border:1px solid #d1d5db; border-left:0; vertical-align:top; padding:0;">
      <div style="border-bottom:1px solid #d1d5db; padding:3px 7px; background:#f3f4f6; font-weight:700;">Ship To</div>
      <div style="padding:6px 8px;">[address lines]</div>
    </td>

    <!-- Column 3: Estimate Details — inner table, border-left:0 prevents double line with col 2 -->
    <td width="33.34%" style="border:1px solid #d1d5db; border-left:0; vertical-align:top; padding:0;">
      <!--
        INNER TABLE RULES:
        - ALL cells of FIRST row: border-top:0 (outer td top border provides it)
        - VALUE cells (right column) ALL rows: border-right:0 (outer td right border provides it)
        - ALL cells of LAST row: border-bottom:0 (outer td bottom border provides it)
        - Left column cells: border-left:0 (outer td left border provides it)
      -->
      <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
        <tr>
          <td style="border:1px solid #d1d5db; border-left:0; border-top:0;
                     padding:3px 7px; background:#f3f4f6; width:42%;">Estimate #</td>
          <td style="border:1px solid #d1d5db; border-left:0; border-top:0; border-right:0;
                     padding:3px 7px;">E00001068</td>
        </tr>
        <tr>
          <td style="border:1px solid #d1d5db; border-left:0; border-top:0;
                     padding:3px 7px; background:#f3f4f6;">Date</td>
          <td style="border:1px solid #d1d5db; border-left:0; border-top:0; border-right:0;
                     padding:3px 7px;">Mar 5, 2026</td>
        </tr>
        <tr>
          <td style="border:1px solid #d1d5db; border-left:0; border-top:0;
                     padding:3px 7px; background:#f3f4f6;">Lead Time</td>
          <td style="border:1px solid #d1d5db; border-left:0; border-top:0; border-right:0;
                     padding:3px 7px;">In stock as of date on quote</td>
        </tr>
        <tr>
          <td style="border:1px solid #d1d5db; border-left:0; border-top:0;
                     padding:3px 7px; background:#f3f4f6;">Rep</td>
          <td style="border:1px solid #d1d5db; border-left:0; border-top:0; border-right:0;
                     padding:3px 7px;">AVP</td>
        </tr>
        <!-- LAST ROW: add border-bottom:0 to BOTH cells -->
        <tr>
          <td style="border:1px solid #d1d5db; border-left:0; border-top:0; border-bottom:0;
                     padding:3px 7px; background:#f3f4f6;">Order Type</td>
          <td style="border:1px solid #d1d5db; border-left:0; border-top:0; border-right:0; border-bottom:0;
                     padding:3px 7px;">Regular Order</td>
        </tr>
      </table>
    </td>
  </tr>
</table>
```

### Notes Section

```html
<!-- border-top:0 = connects to items table (no gap/double line at top)  -->
<!-- border-bottom:0 = Store Policies table provides the divider at bottom -->
<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
  <tr>
    <td style="border:1px solid #d1d5db; border-top:0; border-bottom:0;
               padding:6px 9px; font-size:9.5px; color:#374151;">
      <div style="font-weight:700; font-size:9px; margin-bottom:2px;">NOTES</div>
      <div style="white-space:pre-wrap;">${notes}</div>
    </td>
  </tr>
</table>
```

### Footer: Store Policies + Totals

```html
<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
  <tr style="vertical-align:top;">

    <!-- Store Policies: full border, 60% width -->
    <td style="border:1px solid #d1d5db; padding:6px 8px; width:60%;">[policy text]</td>

    <!-- Totals: outer td provides right + bottom border.
         padding:0 so inner table fills it perfectly.
         border-left:0 prevents double line with Store Policies. -->
    <td style="width:40%; border:1px solid #d1d5db; border-left:0; padding:0; vertical-align:top;">
      <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
        <tr>
          <td style="border-bottom:1px solid #d1d5db; padding:4px 8px; background:#f3f4f6;">Subtotal</td>
          <td style="border-bottom:1px solid #d1d5db; border-left:1px solid #d1d5db; padding:4px 8px; text-align:right;">$51.25</td>
        </tr>
        <tr>
          <td style="border-bottom:1px solid #d1d5db; padding:4px 8px; background:#f3f4f6;">Shipping</td>
          <td style="border-bottom:1px solid #d1d5db; border-left:1px solid #d1d5db; padding:4px 8px; text-align:right;">$12.99</td>
        </tr>
        <tr>
          <td style="border-bottom:1px solid #d1d5db; padding:4px 8px; background:#f3f4f6;">Tax (7%)</td>
          <td style="border-bottom:1px solid #d1d5db; border-left:1px solid #d1d5db; padding:4px 8px; text-align:right;">$3.59</td>
        </tr>
        <!-- Total row: NO border-bottom (outer td provides it) -->
        <tr>
          <td style="padding:6px 8px; background:#0f172a; color:#fff; font-weight:800;">Total</td>
          <td style="border-left:1px solid #d1d5db; padding:6px 8px; background:#0f172a; color:#fff; text-align:right; font-weight:700;">$67.83</td>
        </tr>
      </table>
    </td>

  </tr>
</table>
```

### Quick Border Rule Reference

| Situation | Rule |
|-----------|------|
| Sibling columns (left/right) | Right column: `border-left:0` |
| Inner table, first row | `border-top:0` on all cells |
| Inner table, last row | `border-bottom:0` on all cells |
| Inner table, value cells (right col) | `border-right:0` |
| Inner table, left col cells | `border-left:0` |
| Notes → Store Policies connection | Notes: `border-bottom:0` |

### Print CSS

```css
@media print {
    @page { margin: 12mm 14mm; size: letter; }
    /* Remove flexbox — no min-height:100vh pushing footer to page 2 */
    body { margin: 0 !important; display: block !important; min-height: unset !important; padding: 0 !important; }
    /* Hide flex spacer — without this, 100vh = 1+ print pages, footer goes to page 2 */
    .grow { display: none !important; }
    /* Force browser to print background-color (gray headers, dark Total row) */
    * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
}
body { margin: 12mm 14mm; }
```



---

## 14. QuickBooks Sync

### Arquitectura de Eventos QB

Todos los eventos QB del ciclo de vida de órdenes pasan por **`qb-order-subscriber.ts`**:

| Evento Medusa | Acción QB | Handler |
|---|---|---|
| `order.placed` | Crea Sales Order (o convierte Estimate→SO) | `handleOrderPlaced` |
| `order.payment_captured` | Receive Payment (crédito sin aplicar) | `handlePaymentCaptured` |
| `order.fulfillment_created` | Crea Invoice + aplica pago | `handleFulfillmentCreated` |
| `order.canceled` | Cierra Sales Order + Voidea Invoice | `handleOrderCanceled` |
| `order.customer_transferred` | Reasigna documentos QB al nuevo customer | `handleCustomerTransferred` |

**Principio crítico:** QB failures NUNCA bloquean el flujo de Medusa. El subscriber captura todas las excepciones internamente.

---

### Reliable Event Delivery — emit-order-events.ts

Medusa's internal `emitEventStep` delivers events via Redis, which is not always
reliable in the dev environment. `src/workflows/hooks/emit-order-events.ts` re-emits
events synchronously using `eventBusService.emit()` directly from workflow hooks:

```typescript
// cancelOrderWorkflow.hooks.orderCanceled fires AFTER cancelOrdersStep
// Receives { order } (full object) — NOT { order_id }
cancelHooks.orderCanceled(
    async ({ order }: { order: any }, { container }) => {
        const order_id = order?.id
        const eventBusService = container.resolve(Modules.EVENT_BUS)
        await eventBusService.emit({ eventName: "order.canceled", data: { id: order_id } })
    }
)
```

> ⚠️ **Critical:** The hook receives `{ order }` (full object), NOT `{ order_id }`. Using `{ order_id }` would extract `undefined` and emit the event with `id: undefined`, silently breaking all cancel processing.

---

### Draft Order → QB Estimate

**File:** `components/OrderSidebar.tsx` + `use-order-actions.ts`

The sidebar shows:
- **Estimate QB TxnID** and **Estimate Ref#** (from metadata: `qb_estimate_txn_id`, `qb_estimate_ref`)
- **"Save to QB"** button — calls `POST /admin/quickbooks/draft-order` with `force: true` for re-syncs
- **Re-sync** updates the existing Estimate in QB via `EstimateMod`

```typescript
// OrderSidebar.tsx — state comes from metadata (persisted) OR localRef (just synced)
estimateRef={s.localRef ?? (order.metadata?.qb_estimate_ref as string | null) ?? null}
isSynced={!!(s.localTxnId ?? order.metadata?.qb_estimate_txn_id)}
```

---

### Draft → Order Conversion → QB Sales Order

When a draft order is **converted to a regular order**, a `order.placed` event is emitted by Medusa's native conversion workflow. The `qb-order-subscriber.ts` picks this up and creates the QB Sales Order automatically.

**Flow:**
```
User clicks "Convert to Order"
  → POST /admin/draft-orders/:id/convert-force
    → Medusa native convert-to-order workflow
      → emits order.placed event
        → qb-order-subscriber.ts handles it
          → if qb_estimate_txn_id exists: EstimateToSalesOrder in QB
          → else: SalesOrderAdd in QB
          → saves qb_sales_order_operation_id (pending)
          → QBWC polls → processes → saves qb_sales_order_txn_id
```

> ⚠️ `convert-force` does NOT call `/admin/quickbooks/order` directly — doing so caused duplicate Sales Orders. The subscriber is the only QB trigger.

---

### Web Order → QB Sales Order — Unit Price Fix

**Problem:** Web orders were being created in QB with prices divided by 100 (e.g., $0.51 instead of $51.25).

**Root cause:** The subscriber was using `items.unit_price` from the `order_item` join table (already in cents), then multiplying by 100 again.

**Fix (qb-order-subscriber.ts):** The subscriber now fetches and uses `items.item.unit_price` — the canonical price from the `order_line_item` table (in **dollars/cents correctly handled by Medusa**):

```typescript
// ✅ Canonical price from order_line_item (used for QB)
unit_price: Math.round((item.item?.unit_price ?? item.unit_price ?? 0) * 100)
// items.item.unit_price = order_line_item.unit_price (canonical, in dollars)
// items.unit_price = order_item.unit_price (may differ, avoid for QB)
```

The `query.graph` call must include `items.item.unit_price` in the fields list.

---

### Cancel Order → QB Close SO / Void Invoice

When an order is **cancelled in Medusa**, the `order.canceled` event fires and the subscriber:
1. Fetches the order metadata to get `qb_sales_order_txn_id` and `qb_invoice_txn_id`
2. If an **Invoice** exists → calls `voidInvoiceInQb(invoiceTxnId)` — uses `TxnVoidRq` via bridge DELETE `/api/invoices/:txnId`
3. If a **Sales Order** exists → calls `closeSalesOrderInQb(soTxnId)` — fetches EditSequence then sends `SalesOrderMod` with `IsManuallyClosed=true` via bridge DELETE `/api/sales-orders/:txnId`
4. Logs the operation to Activity Log (`operation: 'cancel'`)

```
User cancels order in Admin UI
  → cancelOrderWorkflow runs
    → orderCanceled hook fires (emit-order-events.ts)
      → eventBusService.emit("order.canceled", { id: order.id })
        → qb-order-subscriber.handleOrderCanceled
          → voidInvoiceInQb(invoiceTxnId)   // if invoice exists
          → closeSalesOrderInQb(soTxnId)    // fetches EditSequence, then closes
          → QbSyncLogger.complete()         // Activity Log entry
```

> **Activity Log timing:** The cancel entry appears in the Activity Log **after** QBWC processes the operation (~30-90 seconds). The entry is immediately created as `processing`, then updated to `completed` once the bridge confirms.

---

### Customer Transfer → QB Document Reassignment

When `order.customer_transferred` fires (e.g., after order ownership change in admin):
- Sales Order is updated to the new customer's `qb_list_id` via `PATCH /api/sales-orders/:txnId/customer`
- Invoice is similarly reassigned
- Both require current `EditSequence` from order metadata

---

### Subscriber Idempotency — 3 Layers (order.placed only)

`qb-order-subscriber.ts` is protected against duplicate `order.placed` events (Redis at-least-once delivery) with three guards:

```typescript
// Layer 1: In-memory Set (module-level singleton)
// JS single-threaded → has() + add() are atomic before first await
// Prevents same-process concurrent duplicate processing
const processingOrders = new Set<string>()
if (processingOrders.has(orderId)) return  // skip
processingOrders.add(orderId)
try {
    // Layer 2: txnId in DB → QBWC already processed the SO (final state)
    if (order.metadata?.qb_sales_order_txn_id) return

    // Layer 3: operationId in DB → SO already queued (QBWC in progress)
    // This closes the race window between events arriving during QBWC polling
    if (order.metadata?.qb_sales_order_operation_id) return

    // ... create SO ...
} finally {
    processingOrders.delete(orderId)  // always release lock
}
```

| Layer | Guard | Survives server restart? |
|-------|-------|-------------------------|
| 1 | In-memory `Set` | ❌ (process-local) |
| 2 | `qb_sales_order_txn_id` in DB | ✅ |
| 3 | `qb_sales_order_operation_id` in DB | ✅ |

**Order Metadata Keys:**

| Key | Description |
|-----|-------------|
| `qb_estimate_txn_id` | QB Estimate TxnID (set when draft is synced) |
| `qb_estimate_ref` | QB Estimate Reference Number |
| `qb_sales_order_operation_id` | Bridge operationId — set immediately when SO is queued (QBWC pending) |
| `qb_sales_order_txn_id` | QB Sales Order TxnID — set after QBWC processes the operation |
| `qb_sales_order_ref` | QB Sales Order Reference Number |
| `qb_payment_txn_id` | QB Payment TxnID |
| `qb_invoice_txn_id` | QB Invoice TxnID |

---

### QB Configuration

From `quickbooks_config` DB table (fallback to env vars):

- `shipping_item_id` — Must be the exact **ListID** of the shipping item in QB (e.g., `800006A3-1395258131`)
- `default_sales_tax_code` — Exact FullName in QB (e.g., `Sale Tax 7%`)

**Tax precedence:** `tax_total === 0` → `taxExempt: true` → QB gets "Exempt". `tax_total > 0` → QB gets `default_sales_tax_code`.

---

### Critical QBXML Rules

- **ListID vs FullName**: Use `ListID` for shipping items. Using `FullName` with `&` fails (even escaped as `&amp;` — triggers silent QB error `0x80040400`)
- **Amount**: `EstimateLineAdd` sends `<Amount>` (total), NOT `<Rate>`. QB calculates rate internally; sending `<Rate>` causes inflated prices
- **EstimateMod**: Existing lines use `EstimateLineMod` (with `TxnLineID`); new lines use `EstimateLineAdd` (no `TxnLineID`)
- **QB Error 3175**: "Transaction could not be locked" — occurs when QB Desktop has the estimate open. Close it in QB Desktop and re-sync
- **close-so requires EditSequence**: `closeSalesOrderInQb()` always queries the SO first to get the current EditSequence before sending the Mod

---

### Activity Log (`qb_sync_log`)

All QB operations log to `qb_sync_log` table and appear in the QuickBooks admin dashboard.

| Operation | Triggered by |
|-----------|-------------|
| `sales_order` | `order.placed` |
| `estimate` | Draft → QB Sync (manual) |
| `payment` | `order.payment_captured` |
| `invoice` | `order.fulfillment_created` |
| `cancel` | `order.canceled` |
| `customer_transfer` | `order.customer_transferred` |
| `inventory_sync` | Scheduled (every 10 min) |
| `price_sync` | Scheduled / manual |
| `customer_sync` | Scheduled / manual |

- Failed entries show the error message **inline** in red (truncated to 120 chars) without needing to expand
- Click any row (▼) to see full details including the complete QB error text
- `cancel` entries appear after QBWC processes the close-so operation (~30-90 seconds delay)

---

## 15. PostgreSQL Tables Reference

| Table | Description |
|-------|-------------|
| `order` | All orders including drafts (`status = 'pending'`) |
| `order_item` | Join: order version → line items |
| `order_line_item` | Item data: `unit_price` (in **cents**), `quantity`, `title`, `variant_id` |
| `order_line_item_tax_line` | Tax lines per item, `code = 'manual'` |
| `order_summary` | JSONB `totals` with `tax_total`, `current_order_total` |
| `product_variant_price_set` | Join: variant → price set |
| `price` | Individual price records (default + price list entries) |
| `price_list` | Price lists (`title = 'Wholesale Pricing'`) |
| `customer` | Metadata: `default_rep`, `is_tax_exempt`, `price_level`, etc. |
| `customer_group` | Groups: "Wholesale Pricing", etc. |
| `customer_group_customers` | Join: customer → group |
| `quickbooks_config` | QB settings: `shipping_item_id`, `default_sales_tax_code` |
| `qb_sync_log` | QB operation log: status, error, duration, txnId |

> ⚠️ `order_line_item` has NO direct `order_id` column. Link is via `order_item` join table.
> ```sql
> -- ❌ Won't work
> SELECT * FROM order_line_item WHERE order_id = '...'
> -- ✅ Use Medusa orderModule.listAndCountOrders({ id }, { relations: ['items'] })
> ```

---

## 16. Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `SENDGRID_API_KEY` | — | Email sending. Without it → `preview_only: true` |
| `SENDGRID_FROM_EMAIL` | `estimates@ecopowertech.com` | Sender address |
| `CHROME_EXECUTABLE_PATH` | `/usr/bin/google-chrome` | Puppeteer PDF |
| `MINIO_ENDPOINT` | — | Minio server URL |
| `MINIO_BUCKET` | `medusa-media` | Bucket for uploads |
| `MINIO_ACCESS_KEY` | — | Credentials |
| `MINIO_SECRET_KEY` | — | Credentials |
| `QB_ORDER_FLOW_ENABLED` | `true` | Enable/disable QB sync |
| `QB_SHIPPING_ITEM_ID` | fallback | Shipping ListID (prefer DB config) |
| `QB_DEFAULT_SALES_TAX_CODE` | fallback | Tax code (prefer DB config) |

**Public logo URL (email body):**
```
https://bucket-production-2e09.up.railway.app/medusa-media/ecopowertech-logo.png
```

---

## 17. Known Issues & Gotchas

| Bug | Fix |
|-----|-----|
| `window.confirm()` blocked | Replaced with toast + React state |
| Print opens new tab | Hidden off-screen iframe |
| Base64 logo broken in Gmail | Public Minio HTTPS URL |
| Dollar amount in email subject | Subject: Estimate # + company only |
| Double border in estimate table | `border-top:0` / `border-bottom:0` on inner cells |
| Footer on page 2 in print | `.grow { display:none }` in `@media print` |
| Background colors stripped in PDF | `print-color-adjust: exact` |
| `pool.end()` hanging → 500 error | `pool.end().catch(() => {})` + `connectionTimeoutMillis: 3000` |
| `allow_backorder` on wrong table | Lives on `product_variant`, NOT `inventory_item` |
| Orphaned reservations | `npx medusa exec src/scripts/fix/cleanup-reservations.ts` |
| Stale Redis after exec script | `npx tsx src/scripts/fix/flush-redis.ts` |
| Wholesale not detected | Requires separate customer fetch — `order.customer.groups` not reliable from orders API |
| Price not saved (stale closure) | Fixed with `useRef` pattern in `use-order-items.ts` |
| Shipping price hidden during save | Fixed: price input stays visible (disabled), "Saving..." in header |
| QB Error 3175 (locked transaction) | Close the Estimate in QB Desktop, then re-sync |
| QB `&` in item name → 0x80040400 | Always use `ListID` not `FullName` for shipping items |
| **Duplicate QB Sales Orders** | **Root cause: `convert-force` had an explicit `fetch(/admin/quickbooks/order)` call AND subscriber also fires. Fixed by removing those calls — subscriber is the only QB trigger** |
| QB widget not auto-refreshing | Fixed: widget polls every 8s until `qb_sales_order_txn_id` appears in metadata |
| Second event slipping past txnId guard | Fixed: added `qb_sales_order_operation_id` check (Layer 3) + in-memory Set mutex (Layer 1) |
| **Web order price ×100 in QB** | **Root cause: subscriber used `items.unit_price` (already in cents) and multiplied ×100. Fixed: now uses `items.item.unit_price` from `order_line_item` (canonical dollar amount)** |
| **Cancel not firing → QB SO stays open** | **Root cause: `emit-order-events.ts` hook destructured `{ order_id }` but `cancelOrderWorkflow` passes `{ order }`. Fixed: now uses `order?.id`** |
| **Activity Log cancel entry missing** | **Normal behavior: cancel entry appears ~30-90s after cancel action (QBWC polling delay). Entry starts as `processing`, completes when QB confirms** |

---

## 18. Inventory & Backorder Architecture

### Key Facts (Medusa v2)

| Field | Table | Purpose |
|-------|-------|---------|
| `allow_backorder` | `product_variant` | `true` = bypass stock check on conversion |
| ~~`allow_backorder`~~ | ~~`inventory_item`~~ | Does NOT exist in `@medusajs/inventory-next` |
| `available_quantity` | `inventory_level` | `stocked_quantity - reserved_quantity` |

### How Conversion Uses `allow_backorder`

```
convert-to-order workflow
  → createReservationsStep
    → inventoryModule.createReservationItems([{ allow_backorder: variant.allow_backorder }])
      → ensureInventoryLevels()
        → if (item.allow_backorder) continue  // skip stock check ← LINE 80
        → if (available < quantity) throw "Not enough stock"
```

### Setup Commands

```bash
# Enable backorder on all variants (run once — already done 2026-03-04)
npx medusa exec src/scripts/enable-variant-backorder.ts
# Result: 344 variants updated

# Flush Redis after exec script updates (invalidate stale cache)
npx tsx src/scripts/fix/flush-redis.ts

# Cleanup orphaned reservations from failed conversion attempts
npx medusa exec src/scripts/fix/cleanup-reservations.ts
```

### `pool.end()` Gotcha

`pg.Pool` to Railway DB: never `await pool.end()` — can hang on TCP timeout and block the request handler.

```typescript
// ✅ Correct
pool.end().catch(() => {})
// Use connectionTimeoutMillis: 3000 in Pool config
```

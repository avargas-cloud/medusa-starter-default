# Draft Orders — Advanced UI & Estimate System
# The Ultimate & Complete Guide

## 📋 Descripción del Documento

| Campo | Detalle |
|-------|---------|
| **Propósito** | Document the Advanced Draft Orders admin page — a complete replacement for Medusa's native draft order detail view, featuring inline item editing, dual-pricing (Default/Wholesale), tax management, store pickup, and a full B2B Estimate workflow with server-side PDF generation and email delivery. |
| **Problemas que resuelve** | Medusa v2's native draft order page lacks wholesale pricing selection, real-time tax management, estimate metadata, PDF generation, and email distribution. The advanced UI adds all of these without replacing the underlying Medusa data layer. |
| **Resultado esperado** | Sales reps can create, price, tax, ship, and distribute professional PDF estimates to customers — all from a single admin page. Estimate status tracks the full sales lifecycle. QuickBooks sync creates Estimates in QB Desktop automatically. |
| **Archivos Clave** | `routes/draft-orders-advanced/[id]/page.tsx`, `components/EstimateInfoBlock.tsx`, `api/admin/draft-orders/[id]/send-estimate/route.ts` |
| **Última revisión** | 2026-03-04 |

## Resumen Ejecutivo

Este documento detalla la arquitectura completa del sistema de Draft Orders avanzado y el flujo de generación y envío de Estimados B2B para EcoPowerTech.

### Logros Principales

✅ **Vista avanzada** en `/app/draft-orders-advanced/:id` con edición de items en tiempo real  
✅ **Dual pricing** — selección de precio Default (retail) o Wholesale por ítem  
✅ **Tax management** — FL 7% o Tax Exempt, persistido en tablas nativas de Medusa  
✅ **Store Pickup** — auto-rellena la dirección de la tienda al seleccionar esta opción  
✅ **Estimate PDF** — generado en el servidor con Puppeteer + Chrome (`/usr/bin/google-chrome`)  
✅ **Print in Store** — iframe oculto, sin abrir nuevas pestañas  
✅ **Email via SendGrid** — PDF adjunto, cuerpo limpio con logo público de Minio  
✅ **Per-field Customer Defaults** — botones azules que aparecen solo cuando el valor difiere del default del customer  
✅ **Activity Timeline** — "Email Sent" con usuario atribuido + tooltip de fecha exacta al hacer hover  
✅ **Auto-status** — status pasa de `Created` → `Sent` automáticamente al enviar correo  
✅ **QB Sync** — crea Estimate en QuickBooks Desktop vía el QB Bridge  
✅ **Convert-Force endpoint** — `/admin/draft-orders/:id/convert-force` con fallback de reservaciones  
✅ **allow_backorder=true** — 344 product variants actualizados via raw SQL para permitir conversión con 0 stock  
✅ **Inventory root cause documented** — `allow_backorder` vive en `product_variant`, no en `inventory_item`  

---

> **Route (UI):** `backend/src/admin/routes/draft-orders-advanced/`  
> **Route (API):** `backend/src/api/admin/draft-orders/[id]/`  
> **Last Updated:** 2026-03-03

---


## Table of Contents

1. [Overview & Purpose](#1-overview--purpose)
2. [File Structure](#2-file-structure)
3. [Two Views: Native vs Advanced](#3-two-views-native-vs-advanced)
4. [Custom Backend Endpoints](#4-custom-backend-endpoints)
5. [Data Hook: useDraftOrderDetail](#5-data-hook-usedraftorderdetail)
6. [Main Detail Page: page.tsx](#6-main-detail-page-pagetsx)
7. [Inline Items Table & Pricing](#7-inline-items-table--pricing)
8. [Taxes (InlineTaxes)](#8-taxes-inlinetaxes)
9. [Shipping (InlineShipping)](#9-shipping-inlineshipping)
10. [Estimate Details Widget (EstimateInfoBlock)](#10-estimate-details-widget-estimateinfoblock)
11. [Customer Widgets](#11-customer-widgets)
12. [Print in Store](#12-print-in-store)
13. [Send Estimate Modal](#13-send-estimate-modal)
14. [Estimate HTML Template & PDF Generation](#14-estimate-html-template--pdf-generation)
15. [Estimate Layout: HTML Table Rules](#15-estimate-layout-html-table-rules)
16. [QuickBooks Sync (OrderSidebar)](#16-quickbooks-sync-ordersidebar)
17. [PostgreSQL Tables Reference](#17-postgresql-tables-reference)
18. [Environment Variables](#18-environment-variables)
19. [Known Bugs & TODO](#19-known-bugs--todo)

---

## 1. Overview & Purpose

The Draft Orders Advanced system is a **custom-built B2B sales workflow** layered on top of Medusa v2's native draft order functionality. It allows EcoPowerTech sales reps to:

- Create and manage draft orders with real-time item/price editing
- Apply wholesale pricing automatically per customer group
- Compute and persist Florida sales tax (7%) or mark as tax-exempt
- Manage shipping (UPS / Store Pickup)
- Fill in estimate metadata: Rep, Lead Time, Order Type, Payment Terms, Project, Notes
- Generate a professional PDF estimate via Puppeteer + Chrome
- Print in-store (hidden iframe, no new tab)
- Email the estimate as a PDF attachment via SendGrid
- Sync to QuickBooks Desktop via the QB Bridge

**This does NOT replace Medusa's native draft order UI.** The advanced UI runs in parallel at a separate URL. Both views share the same underlying data in the database.

---

## 2. File Structure

```
backend/src/
│
├── api/admin/draft-orders/[id]/
│   ├── send-estimate/route.ts       ← HTML template + PDF gen + email dispatch
│   ├── variant-prices/route.ts      ← Returns Default + Wholesale prices per variant
│   ├── compute-tax/route.ts         ← Calculates + persists tax to native view
│   ├── remove-shipping/[mid]/route.ts ← Removes a shipping method
│   └── (other custom endpoints)
│
└── admin/
    ├── routes/draft-orders-advanced/
    │   ├── page.tsx                          ← Draft order LIST (index page)
    │   └── [id]/
    │       ├── page.tsx                      ← Main DETAIL page
    │       ├── types.ts                      ← Shared TypeScript types
    │       ├── helpers.ts                    ← Utility functions (fmt, addrToLines)
    │       ├── hooks/
    │       │   ├── use-draft-order-detail.tsx    ← ALL state + CRUD operations
    │       │   └── use-order-page-state.ts       ← Variant prices + shipping options
    │       └── components/
    │           ├── EstimateInfoBlock.tsx     ← Rep/Terms/LeadTime/Notes form
    │           ├── SendEstimateModal.tsx     ← Email modal
    │           ├── InlineItemsTable.tsx      ← Editable items table
    │           ├── PriceCombobox.tsx         ← Default/Wholesale price selector
    │           ├── InlineTaxes.tsx           ← Tax mode selector + compute
    │           ├── InlineShipping.tsx        ← Shipping method selector
    │           ├── InlineNotes.tsx           ← Estimate notes field
    │           ├── OrderHeader.tsx           ← Top bar (Print/Send/Convert buttons)
    │           ├── OrderSidebar.tsx          ← QB sync + timeline
    │           ├── CustomerBlock.tsx         ← Customer + address display
    │           ├── OrderTotals.tsx           ← Computed totals display
    │           ├── OrderDrawers.tsx          ← All edit modals (address, customer, etc.)
    │           └── PromotionsBlock.tsx       ← Discount codes
    │
    └── widgets/
        ├── customer-estimate-defaults.tsx   ← Customer page: default Rep/Terms
        └── customer-tax-exempt.tsx          ← Customer page: Tax Exempt + doc upload
```

---

## 3. Two Views: Native vs Advanced

| Feature | Native `/app/draft-orders/[id]` | Advanced `/app/draft-orders-advanced/[id]` |
|---------|--------------------------------|------------------------------------------|
| View items | ✅ | ✅ |
| Add/remove items | ✅ (modal) | ✅ (inline search) |
| Wholesale pricing | ❌ | ✅ (Default + Wholesale dropdown) |
| Taxes | ✅ (basic) | ✅ (FL 7%, exempt, auto-persist) |
| Store Pickup auto-address | ❌ | ✅ |
| Estimate Metadata | ❌ | ✅ (EstimateInfoBlock) |
| Print PDF | ❌ | ✅ (hidden iframe) |
| Email PDF | ❌ | ✅ (SendGrid + Puppeteer) |
| QuickBooks Sync | ❌ | ✅ |

---

## 4. Custom Backend Endpoints

### `GET /admin/draft-orders/:id/variant-prices`

Returns all available prices for a set of variants — default retail + any active price lists.

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

> ⚠️ **Prices are in dollars (not cents).** Medusa's `/admin/orders/:id` returns prices in dollars. The separate `/admin/draft-orders/:id` endpoint returns cents — the hook normalizes this (see Section 5).

**Implementation:** Raw SQL via `pg.Pool`. Joins `product_variant_price_set` → `price` → `price_list` using `pl.title` (NOT `pl.name` — that column doesn't exist in v2).

---

### `GET|POST /admin/draft-orders/:id/compute-tax`

**GET** — Returns the computed tax for the order (does NOT write to DB).  
**POST** — Writes tax to Medusa's native tables so both views agree.

**POST body:** `{ "mode": "florida" | "exempt" }`

**Backend behavior on POST:**
1. Gets `DISTINCT` active `item_id`s from the order (deduplicates versioned items)
2. Hard-DELETEs any existing tax lines with `code = 'manual'`
3. Inserts one `order_line_item_tax_line` per item (prorated tax)
4. Updates `order_summary.totals` JSONB: sets `tax_total`, recalculates `current_order_total`

**Tables written:** `order_line_item_tax_line`, `order_summary`

---

### `GET /admin/draft-orders/:id/send-estimate?mode=print`
Returns full estimate HTML + auto-print script for the hidden iframe.

### `GET /admin/draft-orders/:id/send-estimate?mode=email`
Returns full estimate HTML for preview only (no auto-print).

### `POST /admin/draft-orders/:id/send-estimate`
Generates PDF and sends via SendGrid.

**Body:** `{ "to": "email@example.com", "subject": "Estimate #1068 from EcoPowerTech" }`

---

### `POST /admin/draft-orders/:id/convert-force`

Converts a draft order to a regular order. Unlike the native Medusa endpoint, this includes a **fallback mechanism** for inventory issues.

**Flow:**
1. **Attempt 1**: Calls Medusa's native `/admin/draft-orders/:id/complete` (via `convert-to-order`)
2. **If inventory error** (`"Not enough stock available"`): runs the backorder fallback
   - Fetches order line items and default stock location
   - For each item without an existing reservation: creates one via `POST /admin/reservations` with `{ allow_backorder: true }`
   - The `allow_backorder: true` flag bypasses `ensureInventoryLevels()` stock check (see `@medusajs/inventory` line 80)
3. **Attempt 2**: Retries the native conversion
4. **Payment collection fix**: If a `correctTotal` is found in `order_summary`, patches the payment collection amount

> ⚠️ **Key insight**: In Medusa v2, `allow_backorder` lives on **`product_variant`**, NOT `inventory_item`. The conversion workflow reads `variant.allow_backorder` and passes it when creating reservations. This is why updating inventory items doesn't help.

> ⚠️ **Redis cache**: If you update `allow_backorder` via `medusa exec`, run `src/scripts/fix/flush-redis.ts` to invalidate stale cache. The exec script writes to DB but the running server's Redis cache may still hold old values.

**Setup scripts:**
```bash
# Enable allow_backorder on ALL product variants (raw SQL via Knex)
npx medusa exec src/scripts/enable-variant-backorder.ts

# Verify/cleanup orphaned reservations after failed conversion attempts
npx medusa exec src/scripts/fix/cleanup-reservations.ts

# Flush Redis cache (if exec script updated DB but running server still has old cache)
npx tsx src/scripts/fix/flush-redis.ts
```

**`pool.end()` gotcha:** The `readOrderSummaryTotal` helper creates a `pg.Pool` to Railway DB. Never use `await pool.end()` — it can hang on TCP timeout and block the entire request handler. Always use `pool.end().catch(() => {})` with `connectionTimeoutMillis: 3000`.

---

### `GET /admin/estimate-options`

Returns dropdown options for the EstimateInfoBlock form:
```json
{
  "payment_terms": ["Due on Receipt", "Net 15", "Net 30", "Net 60"],
  "lead_times": ["In stock as of date on quote", "1-2 weeks", "2-4 weeks", "4-6 weeks"],
  "order_types": ["Regular Order", "Special Order", "Backorder", "Drop Ship"]
}
```

To add/remove options, edit the static arrays in this route file directly.

---

## 5. Data Hook: useDraftOrderDetail

**File:** `hooks/use-draft-order-detail.tsx`

This is the **brain** of the detail page. It manages ALL state and ALL CRUD operations. The `page.tsx` just calls this hook and passes the results to components.

### Data Fetching Strategy

The hook does a **parallel fetch** (`Promise.all`) on every load:

```typescript
const [oRes, dRes] = await Promise.all([
  // Primary: orders endpoint — prices in DOLLARS, has customer/address info
  fetch(`/admin/orders/${id}?fields=+customer.*,+shipping_address.*,...`, { credentials: "include" }),
  // Secondary: draft-orders endpoint — prices in CENTS, has preview totals
  fetch(`/admin/draft-orders/${id}`, { credentials: "include" }),
])
```

**Why two fetches?** The `/admin/orders/:id` endpoint has richer nested data (customer, addresses, shipping methods) but may have stale totals. The `/admin/draft-orders/:id` endpoint has fresh computed totals (subtotal, tax, shipping) but they're in **cents**. The hook merges both:

```typescript
// CRITICAL: draft-orders endpoint returns prices in CENTS
// orders endpoint returns prices in DOLLARS
// Normalize to always use DOLLARS
const normalizePrice = (cents: number) => cents > 100 ? cents / 100 : cents

const merged = {
  ...rawOrder,                         // from /admin/orders — rich data
  items: normalizedPreviewItems,        // from draft-orders — accurate prices
  subtotal: preview.subtotal / 100,    // cents → dollars
  shipping_total: preview.shipping_total / 100,
  tax_total: preview.tax_total / 100,
  total: preview.total / 100,
}
// Remove qty-0 items (soft-deleted items have quantity set to 0)
merged.items = merged.items.filter((item: any) => item.quantity > 0)
```

### Key Exported State & Handlers

```typescript
const s = useDraftOrderDetail(id)

// Order data
s.order           // The merged DraftOrderDetail object
s.loading         // Boolean
s.fetchError      // Error string or null
s.fetchOrder()    // Re-fetches the order (call after mutations)

// Items
s.handleAddItem(variantId, overridePrice?)  // Add variant to order
s.handleUpdateItem(itemId)                  // Save qty/price changes
s.handleRemoveItem(itemId)                  // Remove item

// Shipping
s.handleAddShipping(optionId, customAmount?) // Add shipping method
s.handleRemoveShipping(methodId)             // Remove shipping method

// QB sync
s.handleSync()        // Trigger QB sync
s.syncing             // Boolean
s.localRef            // QB Estimate Ref# (local state, just synced)
s.localTxnId          // QB TxnID (local state, just synced)

// Estimate status
s.estimateStatus      // "Created" | "Sent" | ""
s.handleStatusChange(status) // Update status
```

---

## 6. Main Detail Page: page.tsx

**File:** `routes/draft-orders-advanced/[id]/page.tsx`

The page orchestrates all components. Key patterns:

### Tax Trigger Pattern
After any item mutation (add/update/remove), taxes must refresh because the tax base changed:

```typescript
const [taxTrigger, setTaxTrigger] = useState(0)
const bumpTax = useCallback(() => setTaxTrigger(n => n + 1), [])

// Wrap item handlers to auto-refresh taxes after save
const handleAddItemWithTax = useCallback(async (variantId, overridePrice?) => {
  await s.handleAddItem(variantId, overridePrice)
  bumpTax()
}, [s.handleAddItem, bumpTax])
```

`InlineTaxes` has a `triggerKey` prop — whenever it changes, the component re-fetches tax.

### Tax Amount Seeding (no flash)
To prevent a 2-second flash where the total shows the wrong amount before taxes load:

```typescript
const taxInitialized = useRef(false)
useEffect(() => {
  // Seed from stored tax_total immediately on mount
  if (!taxInitialized.current && s.order?.tax_total != null && s.order.tax_total > 0) {
    setTaxAmount(s.order.tax_total)
    taxInitialized.current = true
  }
}, [s.order?.tax_total])
```

### Estimate Info Initialization
Customer defaults pre-fill the form if no estimate-specific values exist yet:

```typescript
const m = order.metadata ?? {}
const cm = order.customer?.metadata ?? {}
const initialInfo: EstimateInfo = {
  rep:          (m.estimate_rep          ?? cm.default_rep          ?? "") as string,
  orderType:    (m.estimate_order_type   ?? cm.default_order_type   ?? "") as string,
  leadTime:     (m.estimate_lead_time    ?? cm.default_lead_time    ?? "") as string,
  paymentTerms: (m.estimate_payment_terms ?? cm.default_payment_terms ?? "") as string,
  project:      (m.estimate_project      ?? "") as string,
}
```

### Action Gating (Print / Send)
Both Print and Send are gated by the `getMissingEstimateFields()` utility:

```typescript
onSendEstimate={() => {
  const info = currentEstimateInfo
  if (!info) { setShowEstimateModal(true); return }
  const missing = getMissingEstimateFields(info)
  if (missing.length > 0) {
    // Dynamic import to avoid circular dependency
    import("@medusajs/ui").then(({ toast }) =>
      toast.error(`Please fill in: ${missing.join(", ")}`, {
        description: "These fields are required before sending an estimate."
      })
    )
    return
  }
  setShowEstimateModal(true)
}}
```

### Computed Totals (OrderTotals)
Unit prices from the API are already in dollars. Subtotal is computed on the frontend:

```typescript
const computedSubtotal = order.items.reduce((sum, item) =>
  sum + (item.unit_price ?? 0) * (item.quantity ?? 1), 0
)
// Total = subtotal + shipping - discounts + tax
const total = computedSubtotal + shippingDollars - discountDollars + taxAmount
```

### Page Layout
```
┌─────────────────────────────────────────────────────────┬──────────────────┐
│  OrderHeader (Print/Send/Convert/Delete buttons)        │                  │
│  CustomerBlock (customer info + addresses)              │                  │
│  EstimateInfoBlock (Rep/OrderType/LeadTime/Terms/Notes) │   OrderSidebar   │
│  Items Container                                        │   (QB Sync +     │
│    └─ InlineItemsTable (search + edit + price dropdown) │    Estimate      │
│  PromotionsBlock (discount codes)                       │    Status +      │
│  Notes (InlineNotes)                                    │    Timeline)     │
│  Shipping (InlineShipping)                              │                  │
│  Taxes (InlineTaxes)                                    │                  │
│  OrderTotals                                            │                  │
└─────────────────────────────────────────────────────────┴──────────────────┘
```

---

## 7. Inline Items Table & Pricing

**File:** `components/InlineItemsTable.tsx`

### Item Search
SKU / name search hits MeiliSearch or the backend search endpoint in real-time. Results show variant name, SKU, and available stock by location.

### Price Selection on Add
When a user selects a search result, the price is auto-selected:
```typescript
const contractorP = customerPrices[v.id]?.list?.[0]  // First wholesale price
const defaultP    = customerPrices[v.id]?.default     // Retail price
const price = contractorP ?? defaultP  // Wholesale first, else Default
handleAddItem(v.id, price?.amount)
```

### PriceCombobox (`components/PriceCombobox.tsx`)
Each item row has a price input. If multiple price options exist, a **▾ dropdown** appears:

```
[  $56.75  ▾ ]
  ── Default ──────────
  ● $56.75  (Retail)
  ── Wholesale ────────
    $51.25  (Wholesale Pricing)
```

- Auto-saves after **3 seconds** of inactivity (debounce)
- Saves **immediately** on blur (click out of field)
- Shows `saving…` and `✓` indicators

---

## 8. Taxes (InlineTaxes)

**File:** `components/InlineTaxes.tsx`

A segmented button group with two modes: **Florida (7%)** and **Tax Exempt**.

```tsx
// Modes available
const modes: TaxMode[] = ["florida", "exempt"]

// On mode change — optimistic update first, then server POST
const handleModeChange = async (newMode: TaxMode) => {
  // 1. Optimistically update UI (instant feedback)
  const optimisticAmount = newMode === "exempt" ? 0
    : Math.round(tax.subtotal * 7 / 100 * 100) / 100
  setTax(prev => ({ ...prev, mode: newMode, amount: optimisticAmount }))
  onTaxChange?.(optimisticAmount)

  // 2. Persist to server
  await fetch(`/admin/draft-orders/${orderId}/compute-tax`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode: newMode }),
  })

  // 3. Re-fetch for exact server-computed amount
  await fetchTax()
}
```

The `triggerKey` prop (from `page.tsx`) causes a re-fetch after any item mutation:
```tsx
useEffect(() => { fetchTax() }, [fetchTax, triggerKey])
```

**Tax Exempt badge:** When mode is `exempt`, a green "Exempt" badge appears. The customer's `is_tax_exempt` metadata is displayed in the `customer-tax-exempt.tsx` widget on their Customer detail page.

---

## 9. Shipping (InlineShipping)

**File:** `components/InlineShipping.tsx`

Displays current shipping methods with Change / Remove actions. On "Add Shipping", loads all available methods from the backend:

```tsx
const PICKUP_KEYWORDS = ["pickup", "store pickup", "local pickup", "in store", "in-store"]
const isPickup = (name: string) => PICKUP_KEYWORDS.some(k => name.toLowerCase().includes(k))

// When Store Pickup is selected, auto-set amount to $0
const handleOptionClick = (optId: string, optName: string) => {
  setSelectedOption(optId)
  if (isPickup(optName)) setCustomAmount("0")
  else setCustomAmount("")
}
```

The custom amount field accepts direct dollar input (no cents). Store Pickup auto-fills the store's shipping address (handled in `use-draft-order-detail.tsx`'s `handleShippingChange`):

```typescript
const STORE_ADDRESS = {
  company: "Ecopowertech Inc.",
  address_1: "2760 W 84th St, Unit 4",
  city: "Hialeah", province: "FL",
  postal_code: "33016", country_code: "us",
}
```

Remove is **optimistic** — removes from UI immediately, then DELETEs from server. The parent passes `onRemoved` callback so local state updates instantly.

---

## 10. Estimate Details Widget (EstimateInfoBlock)

**File:** `components/EstimateInfoBlock.tsx`

### Form Fields

| Label | `EstimateInfo` key | Saved to metadata as |
|-------|--------------------|----------------------|
| Rep | `rep` | `estimate_rep` |
| Order Type | `orderType` | `estimate_order_type` |
| Lead Time | `leadTime` | `estimate_lead_time` |
| Payment Terms | `paymentTerms` | `estimate_payment_terms` |
| Project Name | `project` | `estimate_project` |

> Notes are managed separately via `InlineNotes` → saved as `estimate_notes`.

### Auto-save
Every field change immediately POSTs to `/admin/draft-orders/:id`:
```typescript
const persist = async (updated: EstimateInfo) => {
  await fetch(`/admin/draft-orders/${orderId}`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      metadata: {
        estimate_rep: updated.rep,
        estimate_order_type: updated.orderType,
        estimate_lead_time: updated.leadTime,
        estimate_payment_terms: updated.paymentTerms,
        estimate_project: updated.project,
      },
    }),
  })
}
```

### Per-Field Customer Default Buttons

On mount, fetches the customer's current defaults to diff against:
```typescript
useEffect(() => {
  if (customerId) {
    fetch(`/admin/customers/${customerId}`, { credentials: "include" })
      .then(r => r.json())
      .then(({ customer }) => {
        const m = customer?.metadata ?? {}
        setCustomerDefaults({
          rep: m.default_rep ?? "",
          orderType: m.default_order_type ?? "",
          leadTime: m.default_lead_time ?? "",
          paymentTerms: m.default_payment_terms ?? "",
        })
      })
  }
}, [customerId])
```

When a field's value **differs** from `customerDefaults[key]`, a blue button appears inline in the label:

```tsx
{isDifferentFromDefault(key) && (
  <button
    onClick={() => saveFieldDefault(key)}
    className="text-[10px] text-blue-500 hover:text-blue-400 font-medium"
  >
    {isSaving ? "Saving…" : "↑ Set as customer default"}
  </button>
)}
```

Clicking calls:
```typescript
const saveFieldDefault = async (fieldKey: keyof EstimateInfo) => {
  const metaKey = CUSTOMER_DEFAULT_KEYS[fieldKey]  // e.g. "default_rep"
  await fetch(`/admin/customers/${customerId}`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ metadata: { [metaKey]: info[fieldKey] } }),
  })
  // Update local cache so button disappears
  setCustomerDefaults(prev => ({ ...prev, [fieldKey]: info[fieldKey] }))
}
```

> ⚠️ **NEVER use `window.confirm()` in Medusa Admin.** It is silently blocked inside the admin's iframe context. This was the original approach and it failed silently. Always use React state + button patterns.

### Validation
```typescript
export function getMissingEstimateFields(info: EstimateInfo): string[] {
  return REQUIRED_FIELDS
    .filter(f => !info[f.key]?.trim())
    .map(f => f.label)
}
// REQUIRED_FIELDS = [rep, orderType, leadTime, paymentTerms]
// project is NOT required
```

Missing fields show:
- Red `*` after the label name
- Red ring on the select/input
- Red badge in the widget header: `"2 required fields missing"`

---

## 11. Customer Widgets

### customer-estimate-defaults.tsx

**Hook zone:** `customer.details.after`

Manages default estimate values stored in customer metadata. These pre-fill new estimates for that customer.

```typescript
export const config = defineWidgetConfig({
  zone: "customer.details.after",
})

// Seeds from customer metadata on load:
const m = data?.metadata ?? {}
setDefaults({
  default_rep: m.default_rep ?? "",
  default_order_type: m.default_order_type ?? "",
  default_lead_time: m.default_lead_time ?? "",
  default_payment_terms: m.default_payment_terms ?? "",
})

// Auto-saves on every change:
const update = (key: keyof EstimateDefaults, val: string) => {
  const next = { ...defaults, [key]: val }
  setDefaults(next)
  persist(next)  // POSTs to /admin/customers/:id with full metadata object
}
```

Dropdown options come from `GET /admin/estimate-options`. Rep options come from `GET /admin/users`.

### customer-tax-exempt.tsx

**Hook zone:** `customer.details.after`

Manages tax exemption status. Fields stored in customer metadata:

| UI | Metadata Key | Type |
|----|-------------|------|
| Tax Exempt toggle | `is_tax_exempt` | `"Yes"` or `"No"` |
| Tax ID / Certificate # | `tax_id` | string |
| Upload certificate | `tax_exempt_doc_url` | Minio public URL |
| (filename display) | `tax_exempt_doc_name` | string |

File upload flow:
1. User selects file → `FileReader` reads as base64
2. POSTs to `/admin/uploads` (Medusa native file upload → Minio)
3. Response URL stored as `tax_exempt_doc_url` in customer metadata

---

## 12. Print in Store

**Location:** `page.tsx` → `OrderHeader` → `onPrintEstimate` prop

### Why Not `window.open()`?
`window.open()` opens a new browser tab with raw HTML — ugly and disruptive.

### Solution: Hidden Off-Screen iframe

```typescript
onPrintEstimate={() => {
  const info = currentEstimateInfo
  const missing = info ? getMissingEstimateFields(info) : []
  if (missing.length > 0) {
    // Gate: show error toast if estimate incomplete
    import("@medusajs/ui").then(({ toast }) =>
      toast.error(`Please fill in: ${missing.join(", ")}`)
    )
    return
  }

  const iframe = document.createElement("iframe")
  // Position off-screen — never visible to user
  iframe.style.cssText = "position:fixed;top:-9999px;left:-9999px;width:1px;height:1px;border:0;"
  document.body.appendChild(iframe)

  iframe.onload = () => {
    // The autoPrint script inside the HTML calls window.print() on load
    // Clean up the iframe 2 minutes after print dialog opened
    setTimeout(() => {
      try { document.body.removeChild(iframe) } catch {}
    }, 120_000)
  }

  // The HTML at this URL has window.print() injected — triggers browser dialog
  iframe.src = `/admin/draft-orders/${id}/send-estimate?mode=print`
}}
```

> ⚠️ If the iframe had `sandbox` without `allow-modals`, `window.print()` would be silently blocked. The current implementation does NOT set `sandbox` — this is intentional.

### Auto-print script in the HTML
The `send-estimate` route injects this into `?mode=print` responses:
```html
<script>
  window.addEventListener('load', () => {
    setTimeout(() => window.print(), 300)
  })
</script>
```

---

## 13. Send Estimate Modal

**File:** `components/SendEstimateModal.tsx`

A full-screen overlay with:
- **Left panel (280px):** To email, Subject, Send button
- **Right panel:** Live estimate preview (iframe, `?mode=email`)

```tsx
export const SendEstimateModal = ({ open, onClose, orderId, displayId, customerEmail, total, curr }) => {
  const [to, setTo] = useState(customerEmail ?? "")
  const [subject, setSubject] = useState("")

  useEffect(() => {
    if (!open) return
    setTo(customerEmail ?? "")
    // Subject: Estimate # + company ONLY — no dollar amount
    setSubject(`Estimate #${displayId} from EcoPowerTech`)
    loadPreview()
  }, [open, orderId])

  const handleSend = async () => {
    const r = await fetch(`/admin/draft-orders/${orderId}/send-estimate`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to, subject }),
    })
    const j = await r.json()
    if (j.preview_only) {
      // SENDGRID_API_KEY not configured
      toast.warning("SMTP not set up yet — configure SENDGRID_API_KEY in .env")
    } else if (j.success) {
      toast.success(`Estimate sent to ${j.sent_to}`)
      onClose()
    }
  }
```

**Subject format:** `Estimate #1068 from EcoPowerTech`  
❌ NOT `Estimate #1068 from EcoPowerTech – $67.83` (never include total in subject)

**Preview iframe:** Uses `contentDocument.write()` to inject HTML (not `src=`) so the preview loads instantly without a second network round-trip:
```typescript
const doc = iframeRef.current.contentDocument
doc.open(); doc.write(previewHtml); doc.close()
```

---

## 14. Estimate HTML Template & PDF Generation

**File:** `api/admin/draft-orders/[id]/send-estimate/route.ts`

### buildEstimateHtml()
Accepts a `params` object with all order data and returns a complete HTML string. The same template is used for print, email preview, and PDF generation.

### Logo Strategy

| Context | Method | Why |
|---------|--------|-----|
| PDF (Puppeteer) | `data:image/png;base64,LOGO_B64` constant | Puppeteer renders data URIs; no network call |
| Email body | `https://bucket-production-2e09.up.railway.app/medusa-media/ecopowertech-logo.png` | **Gmail blocks `data:` URIs** — must use public HTTPS |

### PDF Generation

```typescript
async function generateEstimatePdf(html: string): Promise<Buffer> {
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
    printBackground: true,   // ← renders background-color on all cells
  })
  await browser.close()
  return Buffer.from(pdfBuffer)
}
```

Uses system Chrome (`/usr/bin/google-chrome`) instead of Puppeteer's bundled Chromium — saves ~200MB and avoids Ubuntu library dependency errors.

### Print CSS

```css
@media print {
  @page { margin: 12mm 14mm; size: letter; }

  /* Remove flexbox body so elements flow naturally (no min-height:100vh pushing footer to page 2) */
  body { margin: 0 !important; display: block !important; min-height: unset !important; padding: 0 !important; }

  /* Hide the flex spacer — without this, 100vh = 1+ print pages, footer goes to page 2 */
  .grow { display: none !important; }

  /* Force browser to print background-color (gray headers, dark Total row strip) */
  * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
}
body { margin: 12mm 14mm; }
```

### SendGrid Email

```typescript
const emailBodyHtml = `... logo + "Your Estimate is Ready" + summary box ...`

// Subject: estimate number only — NO dollar total
const emailSubject = subjectOverride ?? `Estimate #${displayId} from EcoPowerTech`

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

**Resilient delivery:** If Puppeteer fails, the email sends without the PDF attachment (clean summary still delivered).

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
// To add a new rep, add their email → initials pair here
```

---

## 15. Estimate Layout: HTML Table Rules

The estimate PDF uses HTML tables for maximum compatibility. These rules prevent double borders and missing borders.

### Top Header (Logo | Company Info | "Estimate" title)

```html
<table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:8px;">
  <tr>
    <!-- Logo + ECOPOWERTECH text — 36% width -->
    <td style="vertical-align:middle; width:36%;">
      <img src="${LOGO_DATA_URI}" alt="EcoPowerTech" style="height:36px;" />
      <span style="font-size:14px; font-weight:800;">ECOPOWERTECH</span>
    </td>

    <!-- Company info: 3 SEPARATE divs — never one long line (would wrap) -->
    <td style="text-align:center; font-size:9px; color:#555; width:34%;">
      <div>Ecopowertech Inc.</div>
      <div>2760 W 84th St, Unit 4, Hialeah, FL 33016</div>
      <div>Phone: (305) 851-7028 &nbsp;·&nbsp; info@ecopowertech.com</div>
    </td>

    <!-- "Estimate" title — 30% -->
    <td style="text-align:right; vertical-align:top; width:30%;">
      <div style="font-size:22px; font-weight:900;">Estimate</div>
      <div style="font-size:9px; color:#6b7280;">only valid for 30 days</div>
    </td>
  </tr>
</table>
```

### 3-Block Address Header (To / Ship To / Estimate Details)

**Rule: Single `<tr>`, 3 `<td>`s. Browser auto-equalizes heights.**

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

    <!-- Column 3: Estimate Details — border-left:0 prevents double line with col 2 -->
    <td width="33.34%" style="border:1px solid #d1d5db; border-left:0; vertical-align:top; padding:0;">
      <!-- INNER TABLE: each row is a field (Estimate #, Date, Lead Time, Rep, Order Type) -->
      <!-- RULES FOR INNER TABLE CELLS:
           - ALL cells of FIRST row: border-top:0 (outer td top border already provides it)
           - VALUE cells (right column) ALL rows: border-right:0 (outer td right border)
           - ALL cells of LAST row: border-bottom:0 (outer td bottom border provides it)
      -->
      <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
        <tr>
          <td style="border:1px solid #d1d5db; border-left:0; border-top:0;
                     padding:3px 7px; background:#f3f4f6; width:42%;">Estimate #</td>
          <td style="border:1px solid #d1d5db; border-left:0; border-top:0; border-right:0;
                     padding:3px 7px;">E00001068</td>
        </tr>
        <!-- ... Date, Lead Time, Rep rows (same pattern, border-top:0 on all) ... -->
        <tr>
          <!-- LAST ROW: add border-bottom:0 to BOTH cells -->
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
        <tr>
          <!-- Total row: NO border-bottom (outer td provides it) -->
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
| Notes → Store Policies connection | Notes: `border-bottom:0` |

---

## 16. QuickBooks Sync (OrderSidebar)

**File:** `components/OrderSidebar.tsx`

The sidebar shows:
- **Estimate Status** selector: `Created` → `Sent` (saved to `estimate_status` metadata)
- **Estimate Ref#** (if synced to QB): e.g. `E00001068`
- **TxnID** (internal QB transaction identifier)
- **Sync button**: "Save to QuickBooks" → calls `handleSync()` from the hook
- **Timeline**: History of events on this draft order

QB Sync state tracking uses local state first (just-synced), then falls back to metadata:
```typescript
estimateRef={s.localRef ?? (order.metadata?.qb_estimate_ref as string | null) ?? null}
isSynced={!!(s.localTxnId ?? order.metadata?.qb_estimate_txn_id)}
```

For the full QB integration setup and bridge runbook, see **`QUICKBOOKS_BRIDGE_GUIDE.md`**.

---

## 17. PostgreSQL Tables Reference

| Table | Description |
|-------|-------------|
| `order` | All orders including draft orders (`status = 'pending'`) |
| `order_item` | Join between order version and line items |
| `order_line_item` | Item data: `unit_price` (in cents), `quantity`, `title`, `variant_id` |
| `order_line_item_tax_line` | Tax lines per item with `code = 'manual'` |
| `order_summary` | JSONB column `totals` with `tax_total`, `current_order_total` |
| `product_variant_price_set` | Join: variant → price set |
| `price` | Individual price records (default + price list entries) |
| `price_list` | Price lists (`title = 'Wholesale Pricing'`) |
| `customer` | Customers (metadata stores `default_rep`, `is_tax_exempt`, etc.) |

---

## 18. Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `SENDGRID_API_KEY` | — | Email sending. Without it, POST returns `preview_only: true` |
| `SENDGRID_FROM_EMAIL` | `estimates@ecopowertech.com` | Sender address |
| `CHROME_EXECUTABLE_PATH` | `/usr/bin/google-chrome` | Puppeteer PDF generation |
| `MINIO_ENDPOINT` | — | Minio server URL |
| `MINIO_BUCKET` | `medusa-media` | Bucket for file uploads |
| `MINIO_ACCESS_KEY` | — | Minio credentials |
| `MINIO_SECRET_KEY` | — | Minio credentials |

**Public logo URL (email body):**
```
https://bucket-production-2e09.up.railway.app/medusa-media/ecopowertech-logo.png
```

---

## 19. Known Bugs & TODO

### Resolved ✅
- ~~`window.confirm()` blocked in Medusa admin~~ → Replaced with `toast.loading()` for convert button
- ~~Print opens new tab~~ → Hidden off-screen iframe
- ~~Base64 logo broken in Gmail~~ → Public Minio URL
- ~~Dollar amount in email subject~~ → Subject only contains Estimate # and company name
- ~~Double border in Estimate Details column~~ → `border-top:0` / `border-bottom:0` on inner cells
- ~~Missing right/bottom border in Totals section~~ → Outer td provides the border, `padding:0`
- ~~Footer pushed to page 2 in print~~ → `.grow{display:none}` in `@media print`
- ~~Background colors stripped in print PDF~~ → `print-color-adjust:exact`
- ~~Double border at bottom of Notes~~ → `border-bottom:0` on Notes td
- ~~Company address wrapping in header~~ → 3 separate `<div>` lines
- ~~Estimate spacing between sections~~ → `margin-bottom:6px` on items table and notes table
- ~~`pool.end()` hanging and causing 500~~ → `pool.end().catch(() => {})` + `connectionTimeoutMillis:3000`
- ~~Inventory error on convert — wrong field~~ → `allow_backorder` is on `product_variant`, not `inventory_item`
- ~~344 variants with `allow_backorder=false`~~ → Updated via `enable-variant-backorder.ts` raw SQL script
- ~~Orphaned reservations locking draft order~~ → `cleanup-reservations.ts` script for cleanup
- ~~Stale Redis cache after exec script~~ → `flush-redis.ts` script (fixed dotenv path)

### TODO Prioritized 📋

#### 🔴 TOMORROW — Convert Draft Order to Order
- [ ] **Verify conversion works** end-to-end with `allow_backorder=true` on all variants
  - Order #1070 is still a draft — test "Convert to Order" after refreshing page
  - Expected: native `convert-to-order` now succeeds on first attempt (variants have `allow_backorder=true`)
  - If still failing: check convert-force console logs on the backend for specific error
- [ ] **Remove fallback reservation logic** from `convert-force` once native conversion is verified working
  (or keep as safety net)

#### 🟡 PRIORITY — Frontend Stock Control
- [ ] Prevent adding to cart when `inventory_quantity = 0`
- [ ] Cap max quantity in cart at current stock level
- [ ] Show "Out of Stock" badge on product pages
- [ ] Block checkout if any cart item has `qty > available_stock`
- [ ] See implementation plan in `implementation_plan.md` (brain artifacts)
- [ ] **Do NOT modify stock quantities** — control is at UI layer, not DB

#### 🟡 PRIORITY — QuickBooks End-to-End Test
- [ ] **Convert Draft Order → QB Estimate** — verify sync still works after backorder changes
- [ ] **Convert QB Estimate → QB Sales Order** — test the QB Desktop conversion flow
- [ ] **Verify QB bridge polling** — confirm localtunnel interval is 30s (not 2s)

#### 🟢 BACKLOG
- [ ] **Create Draft Order button** — edge case flow needs QA
- [ ] **Wholesale dropdown** — full test after `variant-prices` stability
- [ ] **Multi-page estimate** — test with 10+ items, verify `no-break` prevents policy/totals split

---

## 20. Inventory & Backorder Architecture

### Key Facts (Medusa v2)

| Field | Table | Purpose |
|-------|-------|---------|
| `allow_backorder` | `product_variant` | Controls reservation creation — `true` bypasses stock check |
| ~~`allow_backorder`~~ | ~~`inventory_item`~~ | Does NOT exist in `@medusajs/inventory-next` |
| `available_quantity` | `inventory_level` | `stocked_quantity - reserved_quantity` |
| `reserved_quantity` | `inventory_level` | Updated when reservations are created/deleted |

### How Conversion Uses `allow_backorder`

```
convert-to-order workflow
  → createReservationsStep
    → inventoryModule.createReservationItems([{ ..., allow_backorder: variant.allow_backorder }])
      → ensureInventoryLevels({ validateQuantityAtLocation: true })
        → if (item.allow_backorder) continue  // ← LINE 80: skip stock check
        → if (available < quantity) throw "Not enough stock"  // ← LINE 86
```

### Setup Commands

```bash
# 1. Enable backorder on all variants (run once — already done 2026-03-04)
npx medusa exec src/scripts/enable-variant-backorder.ts
# Result: 344 variants updated

# 2. Flush Redis after any exec script updates (invalidate stale cache)
npx tsx src/scripts/fix/flush-redis.ts

# 3. Cleanup orphaned reservations from failed conversion attempts
npx medusa exec src/scripts/fix/cleanup-reservations.ts
```

### Order Table: `order_line_item` vs `order_item`

In Medusa v2, line items live in `order_line_item` but do NOT have a direct `order_id` column. The link is through `order_item` join table. When writing raw SQL:

```sql
-- ❌ Won't work
SELECT * FROM order_line_item WHERE order_id = '...'

-- ✅ Use Medusa orderModule.listAndCountOrders({ id }, { relations: ['items'] })
-- Then use item.id values to query reservation_item:
SELECT * FROM reservation_item WHERE line_item_id IN (...) AND deleted_at IS NULL
```

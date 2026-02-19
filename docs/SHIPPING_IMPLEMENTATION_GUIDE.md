# Shipping Implementation Guide: Medusa v2 + Astro

> **Purpose:** Complete guide documenting how to implement real-time UPS shipping rates, custom flat-rate ground shipping, store pickup, and intelligent box packing in a Medusa v2 + Astro storefront. Detailed enough to replicate from scratch on a new project.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Environment Variables](#2-environment-variables)
3. [UPS Developer Account Setup](#3-ups-developer-account-setup)
4. [Database: Shipping Settings Table](#4-database-shipping-settings-table)
5. [Backend: Module Structure](#5-backend-module-structure)
6. [Backend: Box Packing Algorithm](#6-backend-box-packing-algorithm)
7. [Backend: UPS Rate Cache](#7-backend-ups-rate-cache)
8. [Backend: Fulfillment Providers](#8-backend-fulfillment-providers)
9. [Backend: Custom API Endpoints](#9-backend-custom-api-endpoints)
10. [Backend: medusa-config.ts Registration](#10-backend-medusa-configts-registration)
11. [Medusa Admin: Shipping Options Setup](#11-medusa-admin-shipping-options-setup)
12. [Product Inventory: Dimension Fields](#12-product-inventory-dimension-fields)
13. [Frontend: medusa-client.ts — getShippingOptions](#13-frontend-medusa-clientts--getshippingoptions)
14. [Frontend: ShippingMethodSelector Component](#14-frontend-shippingmethodselector-component)
15. [Frontend: CheckoutLayout Integration](#15-frontend-checkoutlayout-integration)
16. [How It All Works Together (Flow)](#16-how-it-all-works-together)
17. [Design Decisions & Why](#17-design-decisions--why)
18. [Troubleshooting](#18-troubleshooting)

---

## 1. Architecture Overview

Two distinct pricing paths:

```
GROUND SHIPPING (fast, flat-rate override)
  └─ ground-shipping provider → reads shipping_settings DB table → flat rate
  └─ /shipping-preview endpoint → optimistic price for UI (~150ms)

UPS EXPEDITED (real-time rates)
  └─ ups-ground / ups-next-day-air / ups-2nd-day-air / ups-3-day-select providers
  └─ box-packing.ts → PackageSpec[]
  └─ ups-rate-cache.ts → UPS Shop API (1 call → all services)
  └─ Shared in-memory cache (30s TTL, deduplicates concurrent requests)
```

**Key constraint:** Medusa's fulfillment providers cannot access the DI container during `calculatePrice`. This forced us to use a direct Knex connection and a shared in-memory cache module instead of Medusa services.

---

## 2. Environment Variables

Add to `backend/.env`:

```env
# Database
DATABASE_URL=postgresql://user:password@host:5432/medusa

# UPS OAuth 2.0
UPS_CLIENT_ID=your_ups_client_id
UPS_CLIENT_SECRET=your_ups_client_secret
UPS_SHIPPER_NUMBER=your_ups_account_number

# UPS Origin (your warehouse address)
UPS_ORIGIN_NAME=Your Company Name
UPS_ORIGIN_ADDRESS=123 Main St
UPS_ORIGIN_CITY=Miami Lakes
UPS_ORIGIN_STATE=FL
UPS_ORIGIN_ZIP=33016
UPS_ORIGIN_COUNTRY=US

# CORS
STORE_CORS=http://localhost:4321,https://yourdomain.com
```

---

## 3. UPS Developer Account Setup

1. Go to [developer.ups.com](https://developer.ups.com) → Create account
2. Create an App → Request access to **Rating API**
3. Copy `Client ID` and `Client Secret` → `UPS_CLIENT_ID` / `UPS_CLIENT_SECRET`
4. Get your **Shipper Number** (Account Number) from UPS account settings

The system uses **OAuth 2.0 Client Credentials** (not the legacy API key). Tokens are fetched automatically and cached for 58 minutes.

**UPS Shop Rate endpoint:** `POST https://onlinetools.ups.com/api/rating/v1/Shop`
Returns rates for **all available services** in one call.

| Code | Service |
|------|---------|
| `03` | UPS Ground |
| `01` | UPS Next Day Air |
| `02` | UPS 2nd Day Air |
| `12` | UPS 3 Day Select |

---

## 4. Database: Shipping Settings Table

```sql
CREATE TABLE shipping_settings (
    id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid()::text,
    free_shipping_minimum          INTEGER NOT NULL DEFAULT 29900, -- cents ($299.00)
    regular_ground_shipping_price  INTEGER NOT NULL DEFAULT 1499,  -- cents ($14.99)
    long_item_ground_shipping_price INTEGER NOT NULL DEFAULT 3499, -- cents ($34.99)
    override_ups_ground            BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

INSERT INTO shipping_settings (id, free_shipping_minimum, regular_ground_shipping_price, long_item_ground_shipping_price, override_ups_ground)
VALUES (gen_random_uuid()::text, 29900, 1499, 3499, true);
```

| Column | Description |
|--------|-------------|
| `free_shipping_minimum` | Cart subtotal (cents) above which ground shipping is free |
| `regular_ground_shipping_price` | Flat rate for normal carts (cents) |
| `long_item_ground_shipping_price` | Flat rate when cart has long-profile items (cents) |
| `override_ups_ground` | `true` = use flat rates; `false` = use live UPS Ground rate |

### Shipping Settings Module (Medusa ORM)

`backend/src/modules/shipping-settings-module/models/shipping-settings.ts`:
```typescript
import { model } from "@medusajs/framework/utils"

export const ShippingSettings = model.define("shipping_settings", {
    id: model.id().primaryKey(),
    free_shipping_minimum: model.number(),
    regular_ground_shipping_price: model.number(),
    long_item_ground_shipping_price: model.number(),
    override_ups_ground: model.boolean(),
    created_at: model.dateTime().nullable(),
    updated_at: model.dateTime().nullable(),
})
```

`backend/src/modules/shipping-settings-module/service.ts`:
```typescript
import { MedusaService } from "@medusajs/framework/utils"
import { ShippingSettings } from "./models/shipping-settings"

export default class ShippingSettingsModuleService extends MedusaService({
    ShippingSettings,
}) {}
```

`backend/src/modules/shipping-settings-module/index.ts`:
```typescript
import ShippingSettingsModuleService from "./service"
export default { service: ShippingSettingsModuleService }
```

---

## 5. Backend: Module Structure

```
backend/src/modules/
├── box-packing.ts                  # Shared: CartItems → PackageSpec[]
├── ups-rate-cache.ts               # Shared: UPS Shop API + 30s in-memory cache
├── store-pickup/service.ts         # Free store pickup
├── ground-shipping/service.ts      # Flat-rate ground override (reads shipping_settings)
├── ups-ground-shipping/service.ts  # Live UPS Ground (service code 03)
├── ups-next-day-air/service.ts     # Live UPS Next Day Air (code 01)
├── ups-2nd-day-air/service.ts      # Live UPS 2nd Day Air (code 02)
├── ups-3-day-select/service.ts     # Live UPS 3 Day Select (code 12)
└── shipping-settings-module/       # Medusa ORM model for shipping_settings table

backend/src/api/
├── shipping-preview/route.ts       # GET /shipping-preview?cart_id=...
└── shipping-settings/route.ts      # GET /shipping-settings
```

Each provider's `index.ts` simply exports the service:
```typescript
import MyService from "./service"
export default { service: MyService }
```

---

## 6. Backend: Box Packing Algorithm

**File:** `backend/src/modules/box-packing.ts`

Converts cart items (with dimensions) into one or more `PackageSpec` objects for the UPS API.

### Standard Box Sizes

```typescript
export const STANDARD_BOXES = [
    { name: "XS",  length: 8,  width: 6,  height: 4,  volume: 192,   maxWeight: 70 },
    { name: "S",   length: 12, width: 9,  height: 6,  volume: 648,   maxWeight: 70 },
    { name: "M",   length: 16, width: 12, height: 8,  volume: 1536,  maxWeight: 70 },
    { name: "L",   length: 20, width: 16, height: 10, volume: 3200,  maxWeight: 70 },
    { name: "XL",  length: 24, width: 18, height: 14, volume: 6048,  maxWeight: 70 },
    { name: "XXL", length: 30, width: 24, height: 18, volume: 12960, maxWeight: 70 },
]

const PACKING_EFFICIENCY = 0.70  // 70% of box volume usable
const LONG_ITEM_MAX_DIM = 30     // items > 30" in any dimension → "long item"
```

### Item Classification

```typescript
for (const item of items) {
    const maxDim = Math.max(item.length, item.width, item.height)
    if (maxDim > LONG_ITEM_MAX_DIM) {
        longItems.push(item)    // e.g. 94.5" aluminum channels
    } else {
        regularItems.push(item)
    }
}
```

**Why separate long items?** Items over 30" cannot physically fit in any standard box. A volumetric algorithm would wrongly assign a 94" item to a tiny box — UPS would reject the shipment or charge oversize fees.

### Long Item Bundle Packing

Long items are **bundled** (like pipes/profiles shipped side-by-side). Bundles are split when either limit is hit:

| Limit | Value | Rationale |
|-------|-------|-----------|
| Weight | 70 lbs | UPS standard max per package |
| Cross-section | 12 in² | ~3.5"×3.5" bundle profile |

**Why cross-section instead of volume?** For long items, the LENGTH is constant — only the cross-section (width × height) grows as you bundle more units. Cross-section is the physically meaningful limit.

```typescript
for (const unit of units) {
    const wouldExceedWeight = chunkWeight + unit.weight > 70
    const wouldExceedCross  = chunkCrossSection + unit.crossSection > 12

    if (chunkCount > 0 && (wouldExceedWeight || wouldExceedCross)) {
        packages.push({ weight: chunkWeight, length: maxLength, width: maxWidth, height: maxHeight })
        // reset chunk
    }
    chunkWeight += unit.weight
    chunkCrossSection += unit.crossSection
    chunkCount++
}
// flush last chunk
packages.push({ weight: chunkWeight, length: maxLength, width: maxWidth, height: maxHeight })
```

Package dimensions sent to UPS: `maxLength × maxWidth × maxHeight` from all items in the bundle.

### Regular Item Packing

1. **Single box:** smallest box where `volume × 0.70 ≥ required`, `weight ≤ 70lbs`, AND `maxItemDim ≤ boxMaxDim`
2. **Two boxes:** try volume split ratios (50/50, 60/40, 70/30…), pick lowest combined volume
3. **Fallback:** two XXL boxes

> **The `maxItemDim ≤ boxMaxDim` check** prevents a thin-but-long item (e.g., 20" rod) from being wrongly placed in an XS box (8") just because its volume is small.

---

## 7. Backend: UPS Rate Cache

**File:** `backend/src/modules/ups-rate-cache.ts`

Singleton module handling all UPS API communication, shared across all provider instances.

| Feature | Implementation |
|---------|---------------|
| OAuth 2.0 token | Fetched once, cached 58 min, shared across all providers |
| Rate caching | 30s in-memory cache keyed by `cartId:postalCode:pkgCount` |
| Request deduplication | All 4 providers triggered simultaneously → only 1 HTTP request fires |

### Cache Key

```typescript
function getCacheKey(cartId: string, postalCode: string, pkgCount: number): string {
    return `${cartId}:${postalCode}:${pkgCount}`
}
```

`pkgCount` in the key ensures stale rates are invalidated when the cart changes (e.g., long item added/removed).

### In-Flight Deduplication

Medusa triggers all 4 UPS providers in parallel via `Promise.all`. Without deduplication, 4 identical UPS API calls would fire simultaneously. With this pattern, only 1 fires and all 4 await the same promise:

```typescript
if (!inFlightRequests.has(cacheKey)) {
    const promise = fetchShopRates(req).then(rates => {
        rateCache.set(cacheKey, { rates, timestamp: Date.now() })
        inFlightRequests.delete(cacheKey)
        return rates
    })
    inFlightRequests.set(cacheKey, promise)
}
return await inFlightRequests.get(cacheKey)!
```

### UPS Shop API Request

```typescript
{
    RateRequest: {
        Shipment: {
            Shipper: { Name, ShipperNumber, Address: { AddressLine, City, StateProvinceCode, PostalCode, CountryCode } },
            ShipTo: { Name, Address: { AddressLine, City, StateProvinceCode, PostalCode, CountryCode } },
            Package: packages.map(pkg => ({
                PackagingType: { Code: "02" },  // customer packaging
                PackageWeight: { UnitOfMeasurement: { Code: "LBS" }, Weight: pkg.weight.toFixed(2) },
                Dimensions: {
                    UnitOfMeasurement: { Code: "IN" },
                    Length: pkg.length.toFixed(2),
                    Width:  pkg.width.toFixed(2),
                    Height: pkg.height.toFixed(2)
                }
            }))
        }
    }
}
// POST https://onlinetools.ups.com/api/rating/v1/Shop
// Returns all available UPS services in one response
```

---

## 8. Backend: Fulfillment Providers

### 8.1 UPS Real-Time Providers (4 providers, same pattern)

All 4 providers (`ups-ground-shipping`, `ups-next-day-air`, `ups-2nd-day-air`, `ups-3-day-select`) follow the identical structure — only `identifier` and `SERVICE_CODE` differ:

```typescript
import { AbstractFulfillmentProviderService } from "@medusajs/framework/utils"
import { getUPSRate } from "../ups-rate-cache"
import { packItems } from "../box-packing"

const SERVICE_CODE = "03"  // 03=Ground, 01=NextDay, 02=2ndDay, 12=3DaySelect
const SERVICE_NAME = "UPS Ground"

class UPSGroundShippingService extends AbstractFulfillmentProviderService {
    static identifier = "ups-ground"

    async calculatePrice(_optionData: any, data: any, context: any) {
        const cart = context?.id ? context : data?.cart

        // 1. Extract dimensions from inventory items
        const rawItems = (cart.items || []).map((item: any) => {
            const inv = item.variant?.inventory_items?.[0]?.inventory_item
            return {
                weight:   parseFloat(inv?.weight ?? item.variant?.weight ?? 1),
                length:   parseFloat(inv?.length ?? item.variant?.length ?? 1),
                width:    parseFloat(inv?.width  ?? item.variant?.width  ?? 1),
                height:   parseFloat(inv?.height ?? item.variant?.height ?? 1),
                quantity: item.quantity || 1,
            }
        })

        // 2. Pack items → PackageSpec[]
        const packages = packItems(rawItems)

        // 3. Get UPS rate (uses cache + deduplication)
        const fromLocation = context?.from_location
        const fromAddress  = fromLocation?.address

        const price = await getUPSRate(SERVICE_CODE, {
            cartId: cart.id,
            postalCode:     cart.shipping_address.postal_code,
            packages,
            shipperName:    fromLocation?.name || process.env.UPS_ORIGIN_NAME || "",
            shipperAddress: fromAddress?.address_1 || process.env.UPS_ORIGIN_ADDRESS || "",
            shipperCity:    fromAddress?.city || process.env.UPS_ORIGIN_CITY || "",
            shipperState:   fromAddress?.province || process.env.UPS_ORIGIN_STATE || "",
            shipperZip:     fromAddress?.postal_code || process.env.UPS_ORIGIN_ZIP || "",
            shipperCountry: (fromAddress?.country_code || "US").toUpperCase(),
            shipToName:     cart.shipping_address.company || cart.shipping_address.first_name || "",
            shipToAddress:  cart.shipping_address.address_1 || "",
            shipToCity:     cart.shipping_address.city || "",
            shipToState:    cart.shipping_address.province || "",
            shipToCountry:  (cart.shipping_address.country_code || "US").toUpperCase(),
        })

        if (price !== null) {
            return { calculated_amount: price, is_calculated_price_tax_inclusive: false }
        }

        // Throw → Medusa hides this option from UI (correct behavior when rate unavailable)
        throw new Error(`${SERVICE_NAME}: rate unavailable for cart ${cart.id}`)
    }

    async validateOption()              { return true }
    async validateFulfillmentData(_o: any, data: any) { return data }
    async canCalculate()                { return true }
    async createFulfillment()           { return { data: { method: `ups-${SERVICE_CODE}` } } }
    async cancelFulfillment()           { return {} }
    async getFulfillmentOptions()       { return [{ id: "ups-ground", name: SERVICE_NAME }] }
    async retrieveDocuments()           { return null }
}

export default UPSGroundShippingService
```

> **`context?.id ? context : data?.cart`** — Medusa passes the cart differently in preview vs. calculate calls. This handles both cases.

> **Throwing vs. returning 0** — Returning 0 makes the option appear "Free." Throwing causes Medusa to silently hide it — correct when UPS can't provide a rate.

### 8.2 Ground Shipping Override Provider

**File:** `backend/src/modules/ground-shipping/service.ts`

Smart flat-rate provider. Uses `__pg_connection__` (Knex, injected by Medusa) to read settings and detect long items:

```typescript
import { AbstractFulfillmentProviderService } from "@medusajs/framework/utils"
import Knex from "knex"

class GroundShippingService extends AbstractFulfillmentProviderService {
    static identifier = "ground-shipping"
    private knex: Knex.Knex

    constructor({ __pg_connection__ }: { __pg_connection__: Knex.Knex }) {
        super()
        this.knex = __pg_connection__
    }

    async calculatePrice(_optionData: any, data: any, context: any) {
        const cart = data?.cart || (context?.id ? context : null)

        // Read settings via raw Knex (DI container not available here)
        const [settings] = await this.knex("shipping_settings")
            .select("free_shipping_minimum", "regular_ground_shipping_price",
                    "long_item_ground_shipping_price", "override_ups_ground")
            .limit(1)

        if (!settings?.override_ups_ground) {
            throw new Error("Ground Shipping: override disabled")
            // → Medusa hides this; UPS Ground option shows instead
        }

        // Cart total in cents (unit_price is in dollars in calculatePrice context)
        const cartTotalCents = Math.round(
            (cart.items || []).reduce((sum: number, item: any) =>
                sum + (item.unit_price * (item.quantity || 1)), 0) * 100
        )

        // Check for long items via DB junction table
        // (Medusa does NOT populate shipping_profile in calculatePrice — must query DB directly)
        const productIds = (cart.items || [])
            .map((item: any) => item.variant?.product_id || item.product_id)
            .filter(Boolean)

        let hasLongItems = false
        if (productIds.length > 0) {
            const results = await this.knex("product")
                .join("product_shipping_profile as psp", "psp.product_id", "product.id")
                .join("shipping_profile", "shipping_profile.id", "psp.shipping_profile_id")
                .whereIn("product.id", productIds)
                .whereRaw("LOWER(shipping_profile.name) LIKE '%long%'")
                .select("product.id")
            hasLongItems = results.length > 0
        }

        if (cartTotalCents >= settings.free_shipping_minimum)
            return { calculated_amount: 0, is_calculated_price_tax_inclusive: false }
        if (hasLongItems)
            return { calculated_amount: settings.long_item_ground_shipping_price, is_calculated_price_tax_inclusive: false }
        return { calculated_amount: settings.regular_ground_shipping_price, is_calculated_price_tax_inclusive: false }
    }
}
```

> **Why Knex directly?** Fulfillment providers receive the IoC container via constructor destructuring. `__pg_connection__` is Medusa's internal raw Knex instance — the easiest way to bypass the DI container limitation.

> **Why query `product_shipping_profile` directly?** Medusa v2 doesn't populate `shipping_profile` in the `calculatePrice` context.

### 8.3 Store Pickup Provider

Always returns 0:

```typescript
class StorePickupService extends AbstractFulfillmentProviderService {
    static identifier = "store-pickup"
    async calculatePrice() {
        return { calculated_amount: 0, is_calculated_price_tax_inclusive: false }
    }
    async getFulfillmentOptions() {
        return [{ id: "store-pickup", name: "Store Pickup" }]
    }
    // ... required stubs
}
```

---

## 9. Backend: Custom API Endpoints

### 9.1 GET /shipping-preview?cart_id=...

**File:** `backend/src/api/shipping-preview/route.ts`

Returns the ground shipping price in ~150ms using only DB reads (no UPS API call). Used by the frontend to show optimistic prices instantly while UPS rates load in the background.

```
Response:
{
  "ground": { "price_cents": 3499, "is_free": false, "is_long": true },
  "settings": { "free_shipping_minimum": 29900, "regular_ground_shipping_price": 1499,
                 "long_item_ground_shipping_price": 3499, "override_ups_ground": true },
  "cart_total_cents": 23548
}
```

Runs two parallel queries: `shipping_settings` + `cart_line_item` for the given `cart_id`, then checks for long items via `product_shipping_profile` junction table. Identical logic to `ground-shipping/service.ts`.

Both custom endpoints must **manually set CORS headers** since they live outside Medusa's `/store` or `/admin` namespaces:

```typescript
function setCorsHeaders(req: MedusaRequest, res: MedusaResponse) {
    const allowedOrigins = (process.env.STORE_CORS || "").split(",")
    const origin = req.headers.origin || ""
    if (allowedOrigins.includes(origin) || origin.startsWith("http://localhost")) {
        res.setHeader("Access-Control-Allow-Origin", origin)
    }
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS")
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-publishable-api-key")
    res.setHeader("Access-Control-Allow-Credentials", "true")
}
export const OPTIONS = async (req, res) => { setCorsHeaders(req, res); res.status(204).end() }
```

### 9.2 GET /shipping-settings

**File:** `backend/src/api/shipping-settings/route.ts`

Returns current config values from `shipping_settings`. Used by the admin UI.

---

## 10. Backend: medusa-config.ts Registration

```typescript
// Fulfillment module — all providers registered here
{
    resolve: "@medusajs/medusa/fulfillment",
    options: {
        providers: [
            { resolve: "@medusajs/medusa/fulfillment-manual", id: "manual",          options: {} },
            { resolve: "./src/modules/store-pickup",          id: "store-pickup",    options: {} },
            { resolve: "./src/modules/ground-shipping",       id: "ground-shipping", options: {} },
            { resolve: "./src/modules/ups-ground-shipping",   id: "ups-ground",      options: {} },
            { resolve: "./src/modules/ups-next-day-air",      id: "ups-next-day-air",options: {} },
            { resolve: "./src/modules/ups-2nd-day-air",       id: "ups-2nd-day-air", options: {} },
            { resolve: "./src/modules/ups-3-day-select",      id: "ups-3-day-select",options: {} },
        ],
    },
},
// Shipping settings module (for ORM access)
{
    resolve: "./src/modules/shipping-settings-module",
},
```

Note: UPS credentials live in ENV vars, not in the config above — the providers read `process.env.UPS_*` directly in `ups-rate-cache.ts`.

---

## 11. Medusa Admin: Shipping Options Setup

Go to **Admin → Settings → Regions → [Region] → Shipping Options** and create one option per provider:

| Name | Provider | Price Type |
|------|---------|-----------|
| Store Pickup | `store-pickup` | Calculated |
| Ground Shipping | `ground-shipping` | Calculated |
| UPS Ground | `ups-ground` | Calculated |
| UPS Next Day Air® | `ups-next-day-air` | Calculated |
| UPS 2nd Day Air® | `ups-2nd-day-air` | Calculated |
| UPS 3 Day Select® | `ups-3-day-select` | Calculated |

### Shipping Profiles

Create a **"Long Item Shipping"** profile in **Settings → Shipping Profiles**. Assign any product with a dimension > 30 inches (e.g., 8-foot aluminum extrusions) to this profile.

The `ground-shipping` provider detects it with:
```sql
WHERE LOWER(shipping_profile.name) LIKE '%long%'
```

---

## 12. Product Inventory: Dimension Fields

Set dimensions on each product variant's **Inventory Item** (in inches and pounds). Providers read these fields:

```typescript
const inv = item.variant?.inventory_items?.[0]?.inventory_item
return {
    weight: parseFloat(inv?.weight ?? item.variant?.weight ?? 1),
    length: parseFloat(inv?.length ?? item.variant?.length ?? 1),
    width:  parseFloat(inv?.width  ?? item.variant?.width  ?? 1),
    height: parseFloat(inv?.height ?? item.variant?.height ?? 1),
    quantity: item.quantity || 1,
}
```

> **Use packaged dimensions** — product + box + padding material. Not the raw product measurements.

> **For linear items (profiles, channels):** The dimensions should reflect the item as it ships (e.g., 94.5" × 1.5" × 1.5" for an 8-foot channel). Include any cover/diffuser in the dimensions if it ships inside.

---

## 13. Frontend: medusa-client.ts — getShippingOptions

**File:** `frontend/src/lib/medusa-client.ts`

```typescript
const SHIPPING_OPTIONS_CACHE_KEY = "medusa_shipping_options_v1"
const SHIPPING_OPTIONS_CACHE_TTL = 3_600_000 // 1 hour

export async function getShippingOptions(cartId: string) {
    // 1. Try sessionStorage cache — avoids ~1.2s GET /store/shipping-options on repeat visits
    const cached = getCachedShippingOptionIds()
    let rawOptions: any[]

    if (cached) {
        rawOptions = cached.options
    } else {
        const data = await medusaFetch(`/store/shipping-options?cart_id=${cartId}`)
        rawOptions = data.shipping_options || []
        setCachedShippingOptionIds(rawOptions)  // cache for 1 hour
    }

    // 2. Calculate prices (always fresh — depends on cart + address)
    //    Medusa's Promise.all triggers all providers simultaneously →
    //    ups-rate-cache deduplication ensures only 1 UPS HTTP request fires
    return Promise.all(
        rawOptions.map(async (option: any) => {
            if (option.price_type === "calculated") {
                const priceData = await medusaFetch(
                    `/store/shipping-options/${option.id}/calculate`,
                    { method: "POST", body: JSON.stringify({ cart_id: cartId }) }
                )
                const amount = priceData.shipping_option?.amount
                    ?? priceData.calculated_price?.calculated_amount
                    ?? priceData.calculated_amount
                return { ...option, amount }
            }
            return option
        })
    )
}
```

**What does caching `rawOptions` save?** The `GET /store/shipping-options` call takes ~1.2 seconds (Medusa iterates all providers). The option list rarely changes. Caching for 1 hour means only 1 slow call per browser session — subsequent visits use cached IDs and only call `/calculate` for fresh prices.

---

## 14. Frontend: ShippingMethodSelector Component

**File:** `frontend/src/features/checkout/components/ShippingMethodSelector.tsx`

Two-phase loading strategy:

### Phase 1: Optimistic Rates (~150ms)
```typescript
// Immediately call /shipping-preview (pure DB, no UPS)
const preview = await fetch(`${medusaUrl}/shipping-preview?cart_id=${cartId}`)
const { ground, settings } = await preview.json()

setRates([
    { id: 'optimistic_pickup', label: 'Store Pickup', cost: 0 },
    { id: 'optimistic_ground',
      label: ground.is_free ? 'Free Shipping (UPS Ground)' : 'Ground Shipping',
      cost: ground.price_cents / 100 }
])
```

User sees correct ground price immediately. UPS rates load in background.

### Phase 2: Real Rates (~1-2s)
```typescript
const shippingOptions = await getShippingOptions(cartId)  // triggers all 4 UPS providers

// Separate pickup, ground, and expedited options
const expediteOptions = shippingOptions.filter(r =>
    !r.label.toLowerCase().includes('ground') &&
    !r.methodId.includes('ground-shipping')
)

if (overrideUpsGround) {
    // Keep Store Pickup + flat-rate Ground UNCHANGED, just APPEND expedited below
    setRates(prev => [...prev, ...expediteOptions])
} else {
    // No override: add real UPS Ground price + expedited
    setRates(prev => [...prev, realGround, ...expediteOptions])
}
setAreRatesReal(true)
```

**Why append instead of replace?** Replacing would flash the UI and lose any selection the user made during loading. Always append expedited below.

### SessionStorage Cache (10-minute TTL)
```typescript
const cacheKey = JSON.stringify({
    items: items.map(i => ({ id: i.productId, qty: i.quantity, vid: i.variationId })),
    zip: shippingAddress?.postcode
})
const storageKey = `ship_${btoa(cacheKey)}`

// On complete, save to cache
sessionStorage.setItem(storageKey, JSON.stringify({ rates: finalRates, timestamp: Date.now() }))

// On load, check cache first (if < 10min old AND has > 2 rates = real rates)
const cached = sessionStorage.getItem(storageKey)
if (cached && Date.now() - cached.timestamp < 600_000 && cachedRates.length > 2) {
    setRates(cachedRates); setAreRatesReal(true); return
}
```

Returns to phase 1 only if cache is expired or too few rates (preventing partial cache from skipping UPS load).

### Free Shipping Progress Message
```tsx
{(rate.id === 'optimistic_ground' || rate.methodId === 'ups_ground') &&
    numericCost > 0 &&
    totals.subtotal < (freeShippingMinimum / 100) && (
    <span className="text-amber-400 text-xs">
        🎁 Add ${((freeShippingMinimum / 100) - totals.subtotal).toFixed(2)} more for FREE shipping!
    </span>
)}
```

`freeShippingMinimum` comes from `/shipping-preview` — reflects the DB value, not a hardcoded constant.

---

## 15. Frontend: CheckoutLayout Integration

**File:** `frontend/src/features/checkout/components/CheckoutLayout.tsx`

### Cart ID (synchronous, no network)
```typescript
// Set cartId synchronously from localStorage — no API call needed
const cartId = localStorage.getItem('ept_cart_v2:cartId')
if (cartId) checkoutStore.setKey('medusaCartId', cartId)
```

> Don't call `sdk.store.cart.retrieve()` here — `cartStore.initCart()` already does it. Duplicate call adds ~300ms.

### Prevent "Cart is Empty" Flash
```typescript
const [cartReady, setCartReady] = useState(false)

useEffect(() => {
    let sawLoading = false
    return cartLoading.subscribe(isLoading => {
        if (isLoading) sawLoading = true
        else if (sawLoading) setCartReady(true)  // true→false cycle = init complete
    })
}, [])

// Render skeleton until ready
if (!cartReady) return <CheckoutSkeleton />
```

Only renders after seeing the loading cycle complete (`true → false`). Without this, the page shows "Cart is Empty" briefly before initialization finishes.

---

## 16. How It All Works Together

```
Customer → Checkout Page
    │
    ├─ [~0ms]   CheckoutLayout reads cartId from localStorage (sync)
    │
    ├─ [~150ms] ShippingMethodSelector: GET /shipping-preview?cart_id=...
    │            └─ Returns flat ground price (DB only, long-item aware)
    │            └─ Shows immediately: "Store Pickup" + "Ground Shipping $14.99"
    │
    ├─ [~200ms] getShippingOptions: GET /store/shipping-options (from sessionStorage cache)
    │
    ├─ [~1-2s]  Promise.all → POST /store/shipping-options/:id/calculate × 6 providers
    │            ├─ store-pickup:      always $0
    │            ├─ ground-shipping:   DB query → flat rate
    │            ├─ ups-ground:        packItems() → getUPSRate("03") ─┐
    │            ├─ ups-next-day-air:  packItems() → getUPSRate("01") ─┤ same promise
    │            ├─ ups-2nd-day-air:   packItems() → getUPSRate("02") ─┤ (deduped)
    │            └─ ups-3-day-select:  packItems() → getUPSRate("12") ─┘
    │                                                  │
    │                                    ups-rate-cache.ts:
    │                                    ├─ Check 30s in-memory cache
    │                                    ├─ Dedup: all 4 share 1 promise
    │                                    └─ POST UPS Shop API → all rates in 1 call
    │
    └─ ShippingMethodSelector appends expedited rates (Store Pickup + Ground UNCHANGED)
       └─ Saves all rates to sessionStorage (10-min TTL)
```

---

## 17. Design Decisions & Why

### Q: Why a custom `/shipping-preview` endpoint?
UPS round-trips take 1-2 seconds. The preview endpoint answers "what's the ground price?" in ~150ms using only Postgres reads, so users see the primary rate immediately.

### Q: Why two ground providers (`ground-shipping` AND `ups-ground`)?
- `ground-shipping` = flat-rate smart pricing (free threshold + long-item detection)
- `ups-ground` = live UPS Ground rate (for when override is disabled)

When `override_ups_ground = true`, the frontend reads + displays the flat rate from `ground-shipping`, and the `ups-ground` option is excluded from the UI via the expedite filter.

### Q: Why not use Medusa's `shipping_profile` in `calculatePrice`?
Medusa v2 does not populate `shipping_profile` in the `calculatePrice` context — it's a framework-level limitation. The workaround: query `product_shipping_profile` junction table directly via Knex.

### Q: Why 70% packing efficiency?
Standard boxes are never completely full due to item shapes and padding. 70% prevents selecting a box that's theoretically large enough by volume but impractically tight in practice.

### Q: Why bundle long items instead of shipping individually?
Linear items (channels, pipes, extrusions) physically travel alongside each other. Shipping 3 × 8-foot channels as 3 separate packages would triple the cost unnecessarily.

### Q: Why cross-section area (not volume) as the bundle split limit?
For long items, LENGTH is constant across all units. Adding more units to a bundle doesn't make it longer — it makes the cross-section grow. Cross-section (width × height) is the physically meaningful constraint.

---

## 18. Troubleshooting

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| UPS auth errors / empty rates | Wrong `UPS_CLIENT_ID` / `UPS_CLIENT_SECRET` | Verify credentials; check Rating API access in UPS Developer Portal |
| Ground always $14.99 (never long-item rate) | Shipping profile not matching or product not assigned | Run `SELECT * FROM shipping_profile WHERE name ILIKE '%long%'` and `SELECT * FROM product_shipping_profile WHERE product_id = 'prod_xxx'` |
| "Rate unavailable" in Medusa logs | UPS can't price that service for that address/package | Normal — Medusa hides the option automatically |
| Rates take 2+ seconds on every visit | sessionStorage cache not working | Check DevTools → Application → sessionStorage for `ship_` keys |
| Wrong box size selected | Inventory item dimensions are 0 or null | Set weight/length/width/height on the Inventory Item in Medusa Admin |
| "Cart is Empty" flash on checkout | `cartReady` cycle not completing | Check `cartLoading` nanostore subscription sees `true → false` |
| `box-packing` log shows wrong dimensions | `packItems()` receiving 0 for dimensions | Check that inventory items have dimensions set; default fallback is `1` inch |

# UPS Shipping System — Rate Cache, Box Packing, and Multi-Provider Architecture
> **Type**: Technical Reference
> **Repo**: backend
> **Last verified**: 2026-04-02
> **Status**: Current

---

## What it is and why it exists

The UPS Shipping System is a multi-module architecture that provides real-time UPS shipping rates for the EcoPowerTech e-commerce store. It consists of:

1. **Four UPS fulfillment providers** — each maps to a UPS service (Ground, Next Day Air, 2nd Day Air, 3 Day Select)
2. **`ups-rate-cache.ts`** — a singleton in-process cache that deduplicates UPS API calls
3. **`box-packing.ts`** — a greedy volumetric box packing algorithm
4. **`ups-rate-preview` admin route** — lets POS staff preview rates without a cart

The system was designed to prevent Medusa from calling the UPS API 4 times (once per provider) for the same cart. The cache reduces that to 1 call per cart+zip+package-count combination within a 30-second window.

---

## Architecture

```
Medusa Checkout (rate calculation)
        │
        ├─► ups-ground-shipping provider
        ├─► ups-next-day-air provider
        ├─► ups-2nd-day-air provider       ─── all call getUPSRate()
        └─► ups-3-day-select provider
                │
                ▼
        ups-rate-cache.ts (singleton)
        ┌─────────────────────────────────────┐
        │ Cache key: cartId:postalCode:pkgCount│
        │ TTL: 30 seconds                      │
        │ In-flight dedup: Map<key, Promise>   │
        │ OAuth token shared across providers  │
        └─────────────────────────────────────┘
                │
                ▼
        box-packing.ts (packItems)
                │
                ▼
        UPS Shop API v1 (single HTTP call)
        → returns rates for ALL service codes
```

---

## box-packing.ts — Volumetric Packing Algorithm

### Box Sizes (XS → XXL)

| Name | Dimensions (L×W×H inches) | Max Weight |
|------|---------------------------|-----------|
| XS | 8×6×4 | 70 lbs |
| S | 12×9×6 | 70 lbs |
| M | 16×12×8 | 70 lbs |
| L | 20×16×10 | 70 lbs |
| XL | 24×18×14 | 70 lbs |
| XXL | 30×24×18 | 70 lbs |

### Packing Rules

- **Packing efficiency**: 70% (items don't pack perfectly, so required volume = item volume / 0.70)
- **Long items** (any dimension > 30"): separated into their own packages using actual dimensions; bundled by weight (max 70 lbs) and cross-section (max 12 in²)
- **Regular items**: try single box first (XS→XXL), then 2-box split at ratios [0.5, 0.6, 0.4, 0.7, 0.3]
- **Fallback**: two XXL boxes if nothing fits

### `packItems(rawItems)` Output

Returns an array of `PackageSpec` objects (`weight`, `length`, `width`, `height`) — one element per physical box. Passed directly to the UPS Shop API.

---

## ups-rate-cache.ts

### Cache Key

```
{cartId}:{postalCode}:{packageCount}
```

Note: package count (not package dimensions) is part of the key. If items change (different box packing), the count change busts the cache.

### In-flight Deduplication

If multiple UPS providers call `getUPSRate()` simultaneously with the same cache key (which always happens during checkout), only the **first** one fires the HTTP request. The others await the same `Promise`. The result is then cached and served to all callers.

### OAuth Token Sharing

The UPS OAuth 2.0 access token is a **module-level singleton** cached for 3500 seconds (token valid 3600s). All 4 provider instances share the same token.

### State Sanitization

The `sanitizeState()` function handles Medusa's province format quirks:
- `"us-fl"` → `"FL"` (Medusa province format)
- `"FLFL"` → `"FL"` (duplicate state bug)
- `"US"` → derived from ZIP prefix (country code in wrong field)

---

## UPS API Call

Uses the **UPS Shop API v1** (`/api/rating/v1/Shop`) with `transactionSrc: "medusa"`. This returns rates for **all available UPS services** in a single call. Each provider then looks up its specific `serviceCode` from the response.

### Service Codes

| Module | Service Code | Service Name |
|--------|-------------|-------------|
| `ups-ground-shipping` | `03` | UPS Ground |
| `ups-next-day-air` | `01` | Next Day Air |
| `ups-2nd-day-air` | `02` | 2nd Day Air |
| `ups-3-day-select` | `12` | 3 Day Select |

### Rate Storage

All rates are stored in **cents** (integer). The cache maps `serviceCode → price in cents`.

---

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `UPS_CLIENT_ID` | OAuth 2.0 client ID |
| `UPS_CLIENT_SECRET` | OAuth 2.0 client secret |
| `UPS_SHIPPER_NUMBER` | UPS account number (for negotiated rates) |
| `UPS_SHIPPER_NAME` | Shipper name on labels |
| `UPS_SHIPPER_ADDRESS_LINE1` | Origin address |
| `UPS_SHIPPER_CITY` | Origin city |
| `UPS_SHIPPER_STATE` | Origin state (2-letter) |
| `UPS_SHIPPER_POSTAL_CODE` | Origin ZIP |
| `UPS_SHIPPER_COUNTRY` | Origin country (default: US) |

---

## Admin Route: `/admin/ups-rate-preview`

Allows POS staff to preview UPS rates for a given destination without placing an order. Used in shipping settings UI.

---

## Key Files

| Type | Full Path | Purpose |
|------|-----------|---------|
| Cache + OAuth | `backend/src/modules/ups-rate-cache.ts` | Singleton rate cache and UPS API client |
| Box Packing | `backend/src/modules/box-packing.ts` | Volumetric packing algorithm |
| Ground Provider | `backend/src/modules/ups-ground-shipping/` | Fulfillment provider (code 03) |
| Next Day Air | `backend/src/modules/ups-next-day-air/` | Fulfillment provider (code 01) |
| 2nd Day Air | `backend/src/modules/ups-2nd-day-air/` | Fulfillment provider (code 02) |
| 3 Day Select | `backend/src/modules/ups-3-day-select/` | Fulfillment provider (code 12) |
| Rate Preview | `backend/src/api/admin/ups-rate-preview/route.ts` | Admin preview endpoint |

---

## Rules

- Never import `ups-rate-cache.ts` as a Medusa module — it is a standalone TypeScript file imported directly by provider services
- The cache TTL (30s) is intentionally short to avoid stale rates during active checkout sessions
- `box-packing.ts` defaults missing item dimensions to 1 inch and missing weight to 1 lb — products should always have dimensions set
- If `UPS_SHIPPER_NUMBER` is blank, negotiated rates may not apply

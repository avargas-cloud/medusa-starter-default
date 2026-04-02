# Shipping Settings Module
> **Type**: Technical Reference
> **Repo**: backend
> **Last verified**: 2026-04-02
> **Status**: Current

---

## What it is and why it exists

The `shipping-settings-module` is a thin Medusa v2 custom module that stores a single row of shipping configuration in the database. It provides a centralized, admin-editable source of truth for ground shipping pricing rules used by the `ground-shipping` fulfillment provider.

It exists to allow non-technical staff to adjust shipping thresholds and pricing through the admin panel without requiring a code deployment.

---

## Architecture

A standard Medusa module built with `MedusaService` factory — no custom methods needed, just CRUD operations on a single model.

```
medusa-config.ts
└── resolves: "./src/modules/shipping-settings-module"

Admin API: /admin/shipping-settings (GET, PUT)
└── Reads/writes ShippingSettings record via this module's service
```

---

## Data Model

Table name: `shipping_settings`

| Field | Type | Purpose |
|-------|------|---------|
| `id` | UUID (PK) | Auto-generated |
| `free_shipping_minimum` | number | Order subtotal threshold (cents) above which ground shipping is free |
| `regular_ground_shipping_price` | number | Fixed price (cents) for standard ground shipping |
| `long_item_ground_shipping_price` | number | Fixed price (cents) for shipments with long items (>30") |
| `override_ups_ground` | boolean | When true, use the fixed prices above instead of live UPS rates |
| `created_at` | datetime (nullable) | Record creation timestamp |
| `updated_at` | datetime (nullable) | Last update timestamp |

### Pricing Logic (used by ground-shipping provider)

```
if order_subtotal >= free_shipping_minimum → $0
else if has_long_items → long_item_ground_shipping_price
else if override_ups_ground → regular_ground_shipping_price
else → live UPS Ground rate
```

---

## API

The settings are exposed via the admin API route at `/admin/shipping-settings`. The route reads a single record (or creates defaults if none exists) and updates it via PUT.

---

## Key Files

| Type | Full Path | Purpose |
|------|-----------|---------|
| Model | `backend/src/modules/shipping-settings-module/models/shipping-settings.ts` | Data model definition |
| Service | `backend/src/modules/shipping-settings-module/service.ts` | MedusaService wrapper |
| Index | `backend/src/modules/shipping-settings-module/index.ts` | Module export |
| Admin Route | `backend/src/api/admin/shipping-settings/route.ts` | GET/PUT endpoint |

---

## Rules

- There should only ever be **one row** in `shipping_settings` — it is a singleton config table
- All monetary values are stored in **cents** (e.g., 5000 = $50.00)
- `override_ups_ground: true` disables live UPS rate lookup entirely for the ground-shipping provider — use with caution in production as it may misprice shipments
